'use strict';

const _ = require('lodash');
const GoogleSpreadsheet = require('google-spreadsheet');
// const creds = require('./client_secret.json');
const Promise = require('bluebird');
const AlexaSchema = require('./alexa-schema');
const DialogFlowSchema = require('./dialog-flow-schema');
const CortanaSchema = require('./cortana-schema');

// Create a document object using the ID of the spreadsheet - obtained from its URL.

const placeholders = {
  slots: 'LIST_OF_',
  intents: 'INTENT',
  utterances: 'UTTERANCES_',
  invocations: 'INVOCATION_NAMES',
  skillGeneral: 'SKILL_GENERAL_INFORMATION',
  skillLocaleSettings: 'SKILL_LOCALE_INFORMATION-',
  skillEnvironmentsInformation: 'SKILL_ENVIRONMENTS_INFORMATION',
  chatbotSlotVariants: 'CHATBOT_SLOT_VARIANTS',
};

const processors = {
  skillEnvironmentsInformation: worksheet => getRows(worksheet).then((rows) => {
    const skillEnvironmentsInformation = _(rows).map((row) => {
      const info = _.pick(row, ['key', 'value', 'environment', 'platform']);

      return info;
    })
    .uniq()
    .value();
    return { skillEnvironmentsInformation };
  }),
  skillGeneral: worksheet => getRows(worksheet).then((rows) => {
    const manifest = { manifestVersion: '1.0' };
    let skillGeneralInfo = _(rows).map((row) => {
      const info = _.pick(row, ['option', 'value', 'key']);

      if (_.toNumber(info.value)) info.value = _.toNumber(info.value);
      if (info.value === 'TRUE') info.value = true;
      if (info.value === 'FALSE') info.value = false;
      return info;
    })
    .uniq()
    .map(info => {
      if (_.includes(info.key, 'distributionCountries')) info.value = info.value.split(',');
      if (_.includes(info.key, 'apis.custom.interfaces[]')) {
        const key = info.key.replace('apis.custom.interfaces[].type.', '');
        info.key = 'apis.custom.interfaces';
        const previousArr = _.get(manifest, info.key, []);

        if (info.value) previousArr.push({ type: key});

        info.value = previousArr;
      }

      if (_.includes(info.key, 'events.subscriptions[]')) {
        const key = info.key.replace('events.subscriptions[].eventName.', '');
        info.key = 'events.subscriptions';
        const previousArr = _.get(manifest, info.key, []);

        if (info.value) previousArr.push({ eventName: key});

        info.value = previousArr;
      }

      if (_.includes(info.key, 'permissions[]')) {
        const key = info.key.replace('permissions[].name.', '');
        info.key = 'permissions';
        const previousArr = _.get(manifest, info.key, []);

        if (info.value) previousArr.push({ name: key});

        info.value = previousArr;
      }
      _.set(manifest, info.key, info.value);

    })
    .value();
    // others[otherName] = rows;
    return { manifest };
  }),
  skillLocaleSettings: worksheet => getRows(worksheet).then((rows) => {
    const locale = worksheet.title.replace(placeholders.skillLocaleSettings, '');
    const manifest = {};
    let skillLocaleSetup = _(rows)
    .map((row) => {
      const info = _.pick(row, ['option', 'value', 'key']);

      if (info.value === 'TRUE') info.value = true;
      if (info.value === 'FALSE') info.value = false;
      return info;
    })
    .uniq()
    .map(info => {
      let key = info.key.replace('locales.', `locales.${locale}.`);

      if (_.includes(key, 'keywords')) info.value = info.value.split(',');
      if (_.includes(key, '[]')) {
        key = key.replace('[]', '');
        const previousArr = _.get(manifest, key, []);
        previousArr.push(info.value);
        info.value = previousArr;
      }

      _.set(manifest, key, info.value);
    })
    .value();
    return { manifest };
  }),
  invocations: worksheet => getRows(worksheet).then((rows) => {
    let invocations = _(rows).map((row) => {
      const info = _.pick(row, ['invocationname', 'environment']);

      // previousIntent = _.isEmpty(info.intent) ? previousIntent : info.intent;
      // info.intent = previousIntent;

      return info;
    })
    .uniq()
    .value();
    // others[otherName] = rows;
    return { invocations };
  }),
  slots: worksheet => getRows(worksheet).then((rows) => {
    const slotName = _.includes(worksheet.title, 'AMAZON.') ? worksheet.title.replace('LIST_OF_', '') : worksheet.title;
    const slotNameSanitize = _.trim(_.toLower(slotName).replace(/_/g, '').replace(/ /g, ''));

    let previousSynonym = '';
    const slotValues = {};
    const slotsDraft = _(rows).map((row) => {
      const info = _.pick(row, [slotNameSanitize, 'synonym']);
      previousSynonym = _.isEmpty(info.synonym) ? previousSynonym : info.synonym;
      info.synonym = _.trim(previousSynonym);
      info.value = _.trim(info[slotNameSanitize]);
      if (_.isEmpty(info.value)) return null;
      return info;
    })
    .compact()
    .uniq()
    .value();

    _.each(slotsDraft, (slotDraft) => {
      const key = slotDraft.value;
      const value = slotDraft.synonym;
      slotValues[key] = value;
    });

    const responses = {};
    const pronunciations = {};
    const slotMap = {};
    // get a key based on the synonym - if no synonym use the slot Name
    // to categorize responses in response file.

    _.each(rows).map((row) => {
      const slotKey = row.synonym ? row.synonym.replace(/\./g, '') : slotName;
      const category = row.category ? row.category.toUpperCase() : slotName.replace('LIST_OF_', '');
      const keys = Object.keys(row).filter((key) => {
        return key.indexOf('response-') === 0 && row[key];
      });

      // Build out responses if they exist in the spreadsheet
      if (keys.length) {
        const newResponse = _.get(responses, `${category}.${slotKey}`, {});
        _.each(keys, (key) => {
          let path = key.replace('response-', '');
          const matches = row[key].match(/\[(.*?)\]/);
          if (matches) path = `${path}.${matches[1]}`;
          const response = matches ? row[key].replace(/\[(.*?)\]/, '') : row[key];

          if (/-alternate([0-9])+/g.test(path)) {
            path = path.replace(/-alternate([0-9])+/g, '');
            const previousResponse = newResponse[path];
            if (!_.isArray(previousResponse)) {
              _.set(newResponse, path, [previousResponse]);
            }
            const array = _.get(newResponse, path);
            array.push(response);
          } else {
            _.set(newResponse, path, response);
          }
        });
        _.set(responses, `${category}.${slotKey}`, newResponse);
      }

      // build out special pronunciations if they exist
      if (row.pronunciation) {
        _.set(pronunciations, slotKey, row.pronunciation);
      }
      // build out category map for use within the skill to know the
      // slot category if the slot has to include multiple categories
      // to work in the interaction model correctly.
      if (row.category) {
        _.set(slotMap, `${slotName}.${slotKey}`, row.category);
      }
    });

    const slots = {};
    slots[slotName] = slotValues;

    // console.log(JSON.stringify({ slots }, null, 2));
    const result = {};
    result.slots = slots;
    result.responses = responses;
    result.pronunciations = pronunciations;
    result.slotMap = slotMap;
    return result;
  }),
  intents: worksheet => getRows(worksheet).then((rows) => {
    let previousIntent;
    let intentsDraft = _(rows).map((row) => {
      const info = _.pick(row, ['intent', 'slottype', 'slotname', 'environment', 'platformslot', 'platformintent']);

      previousIntent = _.isEmpty(info.intent) ? previousIntent : info.intent;
      info.intent = previousIntent;

      return info;
    })
    .uniq()
    .value();

    intentsDraft = _.groupBy(intentsDraft, 'intent');

    // console.log('intentsDraft', intentsDraft)
    const intents = [];
    _.each(intentsDraft, ((value, key) => {

      const intent = key;
      const platformIntent = _(value)
      .filter('platformintent')
      .map('platformintent')
      .map(_.trim)
      .compact()
      .value();

      const slots = _(value)
      .filter('slotname')
      .map(slot => ({
         name: _.camelCase(slot.slotname),
         type: slot.slottype,
         platform: _.chain(slot.platformslot).split(', ').map(_.trim).compact().value() }))
      .compact()
      .uniq()
      .value();

      const environment = _.chain(value)
      .filter('environment')
      .map('environment')
      .uniq()
      .first()
      .split(',')
      .replace(' ', '')
      .value();

      const result = !_.isEmpty(slots) ? { intent, slots, platformIntent } : { intent, platformIntent };

      result.environment = environment;
      intents.push(result);
    }));

    // console.log(JSON.stringify({ intents }, null, 2));

    return { intents };
  }),
  utterances: worksheet => getRows(worksheet).then((rows) => {
    const keys = _.keys(rows[0]).filter(row => _.includes(row, 'intent'));
    const headers = _.pick(rows[0], keys);

    rows = _.drop(rows);

    const utterances = {};

    _.each(headers, (headValue) => {
      utterances[headValue] = [];
    });

    _.each(rows, (row) => {
      _.each(headers, (headValue, headKey) => {
        let value = _.replace(_.trim(row[headKey]), /{([\s\S]+?)}/g, (match) => `{${_.camelCase(match)}}`);
        value = value.split(' ').map(v => _.includes(v, '{') ? v : _.toLower(v)).join(' ');
        if (!_.isEmpty(value)) {
          utterances[headValue].push(value);
        }
      });
    });

    _.each(headers, (headValue) => {
      utterances[headValue] = _.uniq(utterances[headValue]);
    });

    // console.log(JSON.stringify({ utterances }, null, 2));

    return { utterances };
  }),
  chatbotSlotVariants: worksheet => getRows(worksheet).then((rows) => {
    const variants = {};
    _.each(rows, (row) => {
      variants[row.joined] = {
        joined: row.joined,
        split: row.split,
        alt: row.alternatespelling
      };
    });

    return { variants };
  }),
  other: worksheet => getRows(worksheet).then((rows) => {
    const firstRow = _.head(rows);
    const headers = _.chain(firstRow).omit(['_xml', 'id', 'app:edited', '_links']).filter(_.isString).values().value();

    rows = _(rows)
    .drop()
    .map((row) => {
      const newRow = {};

      _.each(headers, (headValue) => {
        const headerToSearch = _.lowerCase(headValue).replace(/ /g, '');
        newRow[_.camelCase(headValue)] = row[headerToSearch];
      });
      return newRow;
    })
    .value();

    const last = _.last(rows);
    let justStringAttr = _.map(last, (value, key) => _.isString(value) ? key : false).filter(_.isString);

    const otherName = worksheet.title;
    //const customRows = rows
    //.map(row => _.omit(row, ['_xml', 'id', 'app:edited', '_links']))
    //.map(row => _.pick(row, justStringAttr))
    ;

    const others = {};
    others[otherName] = rows;
    return { others };
  }),
};

function getWorksheets(spreadsheetId, creds) {
  const doc = new GoogleSpreadsheet(spreadsheetId);
  return new Promise((resolve, reject) => doc.useServiceAccountAuth(creds, (error) => {
    if (error) return reject(error);
    return doc.getInfo((err, info) => {
      if (err) return reject(err);
      return resolve(info);
    });
  }));
}

function getRows(worksheet, offset) {
  if (!_.isNumber(offset)) {
    offset = 1;
  }
  // offset = offset || 1;
  return new Promise((resolve, reject) => worksheet.getRows({ offset }, (err, rows) => {
    if (err) return reject(err);
    return resolve(rows);
  }));
}

module.exports = (spreadsheetId, creds, othersToDownload, type) => {
  let locale;
  let otherCSV = {};
  return getWorksheets(spreadsheetId, creds)
  .then((info) => {
    const title = info.title;
    locale = AlexaSchema.VALID_LOCALES.find(loc => _.includes(title, loc) || _.includes(title, _.toLower(loc)));
    locale = locale || AlexaSchema.VALID_LOCALES[0];
    return info.worksheets;
  })
  .then((worksheets) => {
    worksheets = worksheets
    .map((worksheet) => {
      let type = _.map(placeholders, (value, key) => {
        const result = worksheet.title.indexOf(value) >= 0 ? key : null;
        return result;
      }).find(result => !_.isEmpty(result));

      type = !type &&  _.includes(othersToDownload, worksheet.title) ? 'other' : type;
      return { type, worksheet };
    })
    .filter(worksheet => worksheet.type);

    return worksheets;
  })
  .then(sheets => Promise.all(sheets.map(sheet => processors[sheet.type](sheet.worksheet))))
  .then((values) => {
    const result = {};

    _.each(values, (value) => {
      _.merge(result, value);
    });
    result.invocations = result.invocations || [{ invocationname: 'invocation name', environment: 'staging' }]
    let schema;
    if (type === 'dialogFlow') schema = new DialogFlowSchema(result);
    if (type === 'cortana') schema = new CortanaSchema(result);
    if (!schema) schema = new AlexaSchema(result)

    schema.locale = locale;
    return schema;
  });
}
