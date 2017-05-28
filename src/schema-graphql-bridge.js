import SimpleSchema from 'simpl-schema';

// Verso-specific hack: Rename these types so they won't cause issue in the UserWithData interface
const typeNamesToModify = [
  "TeacherEmails",
  "TeacherServices",
  "TeacherDemo",
  "TeacherLastActivity",
  "StudentEmails",
  "StudentServices",
  "StudentDemo",
  "StudentLastActivity"
];

const SchemaBridge = {
  schema: (schema, name, { fields, except, custom, wrap=true, interfacePrefix }={}) => {
    const S = schema._schema;
    let keys, content, objs;

    // Get field definitions for the main type
    keys = getFields({schema, fields, except});
    content = keys.keys.map(k => {
      return getFieldSchema(schema, k, name, custom, interfacePrefix);
    });
    content = content.reduce((a,b) => `${a}${b}`);

    // Add the _id field
    content = `
      _id: GraphQLMeteorId!
      ${content}
    `;

    // Get type definitions for the contained objects
    objs = keys.objectKeys.map(k => {
      return getObjectSchema(schema, k, name, custom, interfacePrefix);
    });
    objs = objs.length ? (objs.reduce((a,b) => `${a}${b}`)) : '';

    if(!wrap)
      return { objects: objs, subObjectTypes: objs, fields: content};

    return `
      ${objs}
      type ${name} {
        ${content}
      }
    `;
  },
  resolvers: (schema, name, { fields, except, wrap=true } = {}) => {
    const S = schema._schema;
    let keys = getFields({schema, fields, except}, true);
    let res = {};
    res[name] = {};
    // resolvers for each field - probably not necessary
    keys.keys.forEach(k => {
      res[name][k] = function(root, args, context) {
        return root[k];
      };
    });

    // Rezolvers for the contained objects, defined as new GraphQL types
    keys.objectKeys.forEach(key => {
      let splitter = schema._objectKeys[key+'.']
        ? '.'
        : schema._objectKeys[key+'.$.'] ? '.$.': null;
      if(!splitter)
        return ``;

      if(!schema._objectKeys[key+splitter].length)
        return ``;

      let k = key.split(splitter), attr = k[k.length-1];
      if(k.length == 1)
        obj = res[name];
      else
        obj = k.slice(1, k.length-1).reduce((a,b) => a[camel(b)], res[typeName(k[0],name)]);

      obj[attr] = function(root, args, context) {
        return root[attr];
      };
      res[typeName(key, name)] = {};
    });
    //console.log(res);
    return res;

  },
  // Mocks do not support Objects
  mocks: (schema, name, { fields, except, wrap=true } = {}) => {
    const S = schema._schema;
    let keys = getFields({schema, fields, except}),
      mocks = {};
    keys.keys.forEach(k => {
      if(gqlType[S[k].type])
        mocks[gqlType[S[k].type]] = defaultMocks[gqlType[S[k].type]];
    })

    if(name)
      mocks[name] = () => {
        let obj = {};
        keys.forEach(k => {
          if(gqlType[S[k].type])
            obj[k] = defaultMocks[gqlType[S[k].type]];
        })
        return obj;
      }

    return mocks;
  }
};

const camel = k => k[0].toUpperCase() + k.substr(1);

// If we have a SimpleSchema key for an Object such as "sublist.subobject.attributes" and the entity name : "List"
// we name the new GraphQL type like: ListSublistSubobjectAttributes
const typeName = (key, name) => name + (key.split('.').reduce((a,b) => a+camel(b), ''));

// Get field key definition
const getFieldSchema = (schema, k, name, custom = {}, interfacePrefix) => {
  const S = schema._schema;
  const field = S[k];
  let key = k.substr(k.lastIndexOf(".") + 1), value = null;

  if (custom[k]) {
    value = custom[k];
  } else if (field.type == Object) {
    // If this object has keys, setup a sub-type (e.g. FlipContentUrlMedia)
    if (schema._objectKeys[k + "."] && schema._objectKeys[k + "."].length) {
      value = `${typeName(k, name)}`;
      // If this is a blackbox object
    } else if (field.blackbox) {
      value = gqlType["Blackbox"];
    }
  } else if (field.type == Array && S[`${k}.$`]) {
    const type = S[`${k}.$`].type;
    if (gqlType[type]) {
      value = `[${gqlType[type]}]`;
    } else if (!value && schema._objectKeys[k + ".$."]) {
      // Maybe it is an Object
      value = `[${typeName(k, name)}]`;
    }
  } else {
    const type = gqlType[field.type];
    const fieldRegex = String(field.regEx);

    // A Meteor _id
    if (type === "String" && fieldRegex === String(SimpleSchema.RegEx.Id)) {
      value = gqlType["_id"];
    // A username
    } else if (type === "String" && fieldRegex === String(UsernameRegex)) {
      value = gqlType["Username"];
    // An email
    } else if (
      type === "String" &&
      fieldRegex === String(SimpleSchema.RegEx.Email)
    ) {
      value = gqlType["Email"];
    } else {
      value = `${type}`;
    }
  }

  if (!value) return ``;

  // Rename the type if it's defined in the typeNamesToModify array
  // e.g. TeacherEmails --> UserEmails
  const shouldRenameType = interfacePrefix && typeNamesToModify.some(name => {
    return name === value || `[${name}]` === value;
  })

  if (shouldRenameType)
    value = value.replace('Teacher', interfacePrefix).replace('Student', interfacePrefix);

  if (!field.optional) value += "!";

  return `
    ${key}: ${value}`;
};

// Set a new GraphQL type definition
const getObjectSchema = (schema, key, name, custom, interfacePrefix) => {
  let splitter = schema._objectKeys[key + "."]
    ? "."
    : schema._objectKeys[key + ".$."] ? ".$." : null;
  if (!splitter) return ``;

  let content = schema._objectKeys[key + splitter].map(k => {
    return `${getFieldSchema(schema, `${key + splitter + k}`, name, custom)}`;
  });
  if (!content.length) return ``;
  content = content.reduce((a, b) => `${a}${b}`);

  let type = typeName(key, name);

  if (interfacePrefix && typeNamesToModify.includes(type))
    type = type.replace('Teacher', interfacePrefix).replace('Student', interfacePrefix);

  return `
  type ${type} {
    ${content}
  }`;
};

const getFields = ({schema, fields, except=[]}, noObjects) => {
  const S = schema._schema;
  let keys, objectKeys;

  if(fields && !fields.length)
    fields = null;
  if(except && !except.length)
    except = null;

  // Get firstLevelKeys
  keys = schema._firstLevelSchemaKeys.filter(k => {
    if(noObjects && S[k].type == Object)
      return false;
    if(fields)
      return fields.indexOf(k) > -1;
    if(except)
      return except.indexOf(k) == -1;
    return true;
  });

  // Get the Objects' keys
  objectKeys = Object.keys(schema._objectKeys)
    .map(k => {
      let ind = k.lastIndexOf('.$');
      return k.substring(0, ind > -1 ? ind : k.lastIndexOf('.'))
    })
    .filter(k => {
      if(fields)
        return fields.indexOf(k) > -1;
      if(except)
        return except.indexOf(k) == -1;
      return true;
    });

  return { keys, objectKeys };
};

const UsernameRegex = /^[^@]*$/;

const gqlType = {};
gqlType[String] = 'String';
gqlType[Number] = 'Float';
gqlType[Boolean] = 'Boolean';
gqlType[Date] = 'GraphQLDate';
gqlType['Blackbox'] = 'GraphQLObject';
gqlType['_id'] = 'GraphQLMeteorId';
gqlType[SimpleSchema.RegEx.Id] = 'GraphQLMeteorId';
gqlType['Username'] = 'GraphQLUsername';
gqlType['Email'] = 'GraphQLEmail';

const defaultMocks = {
  String: () => 'It works!',
  Int: () => 6,
  Float: () => 6.2,
  Boolean: () => true,
  Date: () => (new Date()).toString()
}

export default SchemaBridge
