const chai = require('chai');
chai.use(require('deep-equal-in-any-order'));
const sinon = require('sinon');
const rewire = require('rewire');
const moment = require('moment');
const { performance } = require('perf_hooks');

const registrationUtils = require('@medic/registration-utils');
const tombstoneUtils = require('@medic/tombstone-utils');
const config = require('../../../src/config');
const purgingUtils = require('@medic/purging-utils');
const request = require('request-promise-native');
const db = require('../../../src/db');

let service;
let clock;

describe('ServerSidePurge', () => {
  beforeEach(() => {
    service = rewire('../../../src/lib/purging');
  });

  afterEach(() => {
    sinon.restore();
    clock && clock.restore();
  });

  describe('getPurgeFn', () => {
    beforeEach(() => {
      sinon.stub(config, 'get');
    });

    it('should return undefined when purge is not configured', () => {
      config.get.returns(undefined);
      chai.expect(service.__get__('getPurgeFn')()).to.equal(undefined);
      chai.expect(config.get.callCount).to.equal(1);
      chai.expect(config.get.args[0][0]).to.equal('purge');
    });

    it('should return undefined when purge fn is not configured', () => {
      config.get.returns({});
      chai.expect(service.__get__('getPurgeFn')()).to.equal(undefined);
      chai.expect(config.get.callCount).to.equal(1);
      chai.expect(config.get.args[0][0]).to.equal('purge');
    });

    it('should return undefined when purge fn cannot be eval-ed', () => {
      config.get.returns({ fn: 'whatever' });
      chai.expect(service.__get__('getPurgeFn')()).to.equal(undefined);
      chai.expect(config.get.callCount).to.equal(1);
      chai.expect(config.get.args[0][0]).to.equal('purge');
    });

    it('should return undefined when purge fn is not a function', () => {
      config.get.returns({ fn: '"whatever"' });
      chai.expect(service.__get__('getPurgeFn')()).to.equal(undefined);
      chai.expect(config.get.callCount).to.equal(1);
      chai.expect(config.get.args[0][0]).to.equal('purge');
    });

    it('should return eval-ed when purge fn is correct', () => {
      const purgeFn = function(n) { return n * n; };
      config.get.returns({ fn: purgeFn.toString() });
      const result = service.__get__('getPurgeFn')();
      chai.expect(config.get.callCount).to.equal(1);
      chai.expect(config.get.args[0][0]).to.equal('purge');
      chai.expect(result(4)).to.equal(16);
      chai.expect(result(3)).to.equal(9);
    });
  });

  describe('getRoles', () => {
    beforeEach(() => {
      sinon.stub(db.users, 'allDocs');
    });

    it('should throw allDocs errors', () => {
      db.users.allDocs.rejects({ some: 'err' });
      return service.__get__('getRoles')().catch(err => {
        chai.expect(err).to.deep.equal({ some: 'err' });
        chai.expect(db.users.allDocs.callCount).to.equal(1);
        chai.expect(db.users.allDocs.args[0]).to.deep.equal([{ include_docs: true }]);
      });
    });

    it('should return all unique role groups', () => {
      sinon.stub(purgingUtils, 'isOffline').returns(true);
      sinon.stub(purgingUtils, 'getRoleHash').callsFake(roles => JSON.stringify(roles));
      db.users.allDocs.resolves({ rows: [
        { id: 'user1', doc: { roles: ['a', 'b'], name: 'user1' }},
        { id: 'user2', doc: { roles: ['b', 'a'], name: 'user2' }},
        { id: 'user3', doc: { roles: ['b', 'c'], name: 'user3' }},
        { id: 'user4', doc: { roles: ['c', 'a'], name: 'user4' }},
        { id: 'user5', doc: { roles: ['a', 'b', 'c'], name: 'user5' }},
        { id: 'user5', doc: { roles: ['c', 'b', 'c', 'a'], name: 'user5' }},
        { id: 'user6', doc: { roles: ['c', 'b', 'c', 'a'], name: 'user5' }},
        { id: 'user7' },
        { id: 'user7', doc: { roles: 'aaa' } },
        { id: 'user7', doc: { roles: [] } },
      ]});

      return service.__get__('getRoles')().then(roles => {
        chai.expect(Object.keys(roles)).to.deep.equal([
          JSON.stringify(['a', 'b']),
          JSON.stringify(['b', 'c']),
          JSON.stringify(['a', 'c']),
          JSON.stringify(['a', 'b', 'c']),
        ]);
        chai.expect(roles[JSON.stringify(['a', 'b'])]).to.deep.equal(['a', 'b']);
        chai.expect(roles[JSON.stringify(['b', 'c'])]).to.deep.equal(['b', 'c']);
        chai.expect(roles[JSON.stringify(['a', 'c'])]).to.deep.equal(['a', 'c']);
        chai.expect(roles[JSON.stringify(['a', 'b', 'c'])]).to.deep.equal(['a', 'b', 'c']);
      });
    });
  });

  describe('initPurgeDbs', () => {
    beforeEach(() => {
      sinon.stub(db, 'get');
    });

    it('should initialize purge dbs for provided roles', () => {
      const purgedb = { put: sinon.stub().resolves() };
      db.get.returns(purgedb);
      const roles = {
        'hash1': ['a'],
        'hash2': ['b'],
        'hash3': ['c'],
      };
      db.medicDbName = 'dummy';

      return service.__get__('initPurgeDbs')(roles).then(() => {
        chai.expect(db.get.callCount).to.equal(3);
        chai.expect(db.get.args[0]).to.deep.equal(['dummy-purged-role-hash1']);
        chai.expect(db.get.args[1]).to.deep.equal(['dummy-purged-role-hash2']);
        chai.expect(db.get.args[2]).to.deep.equal(['dummy-purged-role-hash3']);
        chai.expect(purgedb.put.callCount).to.equal(3);
        chai.expect(purgedb.put.calledWith({ _id: '_local/info', roles: ['a'] })).to.equal(true);
        chai.expect(purgedb.put.calledWith({ _id: '_local/info', roles: ['b'] })).to.equal(true);
        chai.expect(purgedb.put.calledWith({ _id: '_local/info', roles: ['c'] })).to.equal(true);
      });
    });

    it('should catch info doc save conflicts', () => {
      const purgedb = { put: sinon.stub().rejects({ status: 409 }) };
      db.get.returns(purgedb);
      const roles = {
        'hash': ['1'],
        'hash-': ['2', '3'],
        'hash--': ['4', '5', '6'],
      };
      db.medicDbName = 'not-medic';

      return service.__get__('initPurgeDbs')(roles).then(() => {
        chai.expect(db.get.callCount).to.equal(3);
        chai.expect(db.get.args[0]).to.deep.equal(['not-medic-purged-role-hash']);
        chai.expect(db.get.args[1]).to.deep.equal(['not-medic-purged-role-hash-']);
        chai.expect(db.get.args[2]).to.deep.equal(['not-medic-purged-role-hash--']);
        chai.expect(purgedb.put.callCount).to.equal(3);
        chai.expect(purgedb.put.calledWith({ _id: '_local/info', roles: ['1'] })).to.equal(true);
        chai.expect(purgedb.put.calledWith({ _id: '_local/info', roles: ['2', '3'] })).to.equal(true);
        chai.expect(purgedb.put.calledWith({ _id: '_local/info', roles: ['4', '5', '6'] })).to.equal(true);
      });
    });

    it('should always reinitialize the db objects', () => {
      const purgedb = { put: sinon.stub().resolves() };
      db.get.returns(purgedb);
      const roles = { 'hash': ['1'] };
      db.medicDbName = 'not-medic';

      return service.__get__('initPurgeDbs')(roles).then(() => {
        chai.expect(db.get.callCount).to.equal(1);
        chai.expect(db.get.args[0]).to.deep.equal(['not-medic-purged-role-hash']);
        chai.expect(purgedb.put.callCount).to.equal(1);
        chai.expect(purgedb.put.calledWith({ _id: '_local/info', roles: ['1'] })).to.equal(true);
      });
    });

    it('should throw db save errors', () => {
      const purgedb = { put: sinon.stub().rejects({ some: 'err' }) };
      db.get.returns(purgedb);
      const roles = {
        'hash': ['1'],
        'hash-': ['2', '3'],
        'hash--': ['4', '5', '6'],
      };
      db.medicDbName = 'not-medic';

      return service
        .__get__('initPurgeDbs')(roles)
        .catch(err => {
          chai.expect(err).to.deep.equal({ some: 'err' });
        });
    });
  });

  describe('closePurgeDbs', () => {
    it('should not crash when no purge DBs are cached', () => {
      service.__get__('closePurgeDbs')();
    });

    it('should not crash for falsy dbs', () => {
      sinon.stub(db, 'close');
      service.__set__('purgeDbs', { one: false, two: undefined, three: null });
      service.__get__('closePurgeDbs')();
      chai.expect(db.close.callCount).to.equal(3);
      chai.expect(db.close.args).to.deep.equal([[false], [undefined], [null]]);
    });

    it('should call close function for every db', () => {
      sinon.stub(db, 'close');
      const dbs = { one: 'one', two: 'two', three: 'three', four: false };
      const purgeDbs = Object.assign({}, dbs);
      service.__set__('purgeDbs', purgeDbs);
      service.__get__('closePurgeDbs')();
      chai.expect(db.close.callCount).to.equal(4);
      chai.expect(db.close.args).to.deep.equal([['one'], ['two'], ['three'], [false]]);
      chai.expect(Object.keys(purgeDbs)).to.deep.equal([]);
    });
  });

  describe('getAlreadyPurgedDocs', () => {
    let purgeDbChanges;

    beforeEach(() => {
      purgeDbChanges = sinon.stub();
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges });
    });

    it('should work with no ids', () => {
      return service.__get__('getAlreadyPurgedDocs')(['a', 'b']).then(results => {
        chai.expect(results).to.deep.equal({ 'a': {}, 'b': {} });
        chai.expect(db.get.callCount).to.equal(0);
      });
    });

    it('should throw db errors', () => {
      purgeDbChanges.rejects({ some: 'err' });
      return service.__get__('getAlreadyPurgedDocs')(['a', 'b'], [1, 2]).catch(err => {
        chai.expect(err).to.deep.equal({ some: 'err' });
      });
    });

    it('should request changes with purged ids for every purge db', () => {
      const hashes = ['a', 'b', 'c'];
      const ids = ['1', '2', '3', '4'];
      purgeDbChanges.resolves({ results: [] });
      return service.__get__('getAlreadyPurgedDocs')(hashes, ids).then(results => {
        chai.expect(results).to.deep.equal({ 'a': {}, 'b': {}, 'c': {} });
        chai.expect(db.get.callCount).to.equal(3);
        chai.expect(purgeDbChanges.callCount).to.equal(3);
        chai.expect(purgeDbChanges.args[0]).to.deep.equal([{
          doc_ids: ['purged:1', 'purged:2', 'purged:3', 'purged:4'],
          batch_size: 5,
          seq_interval: 4
        }]);
        chai.expect(purgeDbChanges.args[1]).to.deep.equal(purgeDbChanges.args[0]);
        chai.expect(purgeDbChanges.args[2]).to.deep.equal(purgeDbChanges.args[0]);
      });
    });

    it('should group purges by roles and id, skipping deleted purges', () => {
      const hashes = ['a', 'b', 'c'];
      const ids = ['1', '2', '3', '4', '5', '6'];

      purgeDbChanges.onCall(0).resolves({
        results: [
          { id: 'purged:2', changes: [{ rev: '2-rev' }] },
          { id: 'purged:3', changes: [{ rev: '3-rev' }] },
          { id: 'purged:4', changes: [{ rev: '4-rev' }], deleted: true },
          { id: 'purged:5', changes: [{ rev: '5-rev' }] },
        ]
      });

      purgeDbChanges.onCall(1).resolves({
        results: [
          { id: 'purged:1', changes: [{ rev: '1-rev' }] },
          { id: 'purged:6', changes: [{ rev: '6-rev' }] },
        ]
      });

      purgeDbChanges.onCall(2).resolves({
        results: [
          { id: 'purged:1', changes: [{ rev: '1-rev' }], deleted: true },
          { id: 'purged:3', changes: [{ rev: '3-rev' }] },
          { id: 'purged:4', changes: [{ rev: '4-rev' }] },
          { id: 'purged:6', changes: [{ rev: '6-rev' }], deleted: true },
        ]
      });

      return service.__get__('getAlreadyPurgedDocs')(hashes, ids).then(results => {
        chai.expect(results).to.deep.equal({
          'a': { '2': '2-rev', '3': '3-rev', '5': '5-rev' },
          'b': { '1': '1-rev', '6': '6-rev' },
          'c': { '3': '3-rev', '4': '4-rev' },
        });
      });
    });
  });

  describe('updatePurgedDocs', () => {
    let purgeDbBulkDocs;
    beforeEach(() => {
      purgeDbBulkDocs = sinon.stub();
      sinon.stub(db, 'get').returns({ bulkDocs: purgeDbBulkDocs });
    });

    it('should update nothing if nothing provided', () => {
      return service.__get__('updatePurgedDocs')(['a'], ['1', '2', '3'], { 'a': {}}, { 'a': {}}).then(() => {
        chai.expect(purgeDbBulkDocs.callCount).to.equal(0);
      });
    });

    it('should throw db errors', () => {
      const roles = ['a', 'b'];
      const ids = ['1', '2', '3', '4'];
      const currentlyPurged = {
        'a': { '1': '1-rev', '3': '3-rev' },
        'b': { '2': '2-rev', '4': '4-rev' },
      };

      const newPurged = {
        'a': { '1': true, '2': true },
        'b': {'1': true, '4': true },
      };

      purgeDbBulkDocs.onCall(1).rejects({ some: 'err' });

      return service.__get__('updatePurgedDocs')(roles, ids, currentlyPurged, newPurged).catch(err => {
        chai.expect(err).to.deep.equal({ some: 'err' });
      });
    });

    it('should add new purges and remove old purges', () => {
      const roles = ['a', 'b'];
      const ids = ['1', '2', '3', '4'];
      const currentlyPurged = {
        'a': {
          '1': '1-rev',
          '3': '3-rev',
        },
        'b': {
          '2': '2-rev',
          '4': '4-rev',
        }
      };

      const newPurged = {
        'a': {
          '1': true,
          '2': true,
        },
        b: {
          '1': true,
          '4': true,
        }
      };

      return service.__get__('updatePurgedDocs')(roles, ids, currentlyPurged, newPurged).then(() => {
        chai.expect(purgeDbBulkDocs.callCount).to.equal(2);
        chai.expect(purgeDbBulkDocs.args[0]).to.deep.equal([{ docs: [
          { _id: 'purged:2' },
          { _id: 'purged:3', _rev: '3-rev', _deleted: true }
        ]}]);
        chai.expect(purgeDbBulkDocs.args[1]).to.deep.equal([{ docs: [
          { _id: 'purged:1' },
          { _id: 'purged:2', _rev: '2-rev', _deleted: true }
        ]}]);
      });
    });

    it('should skip empty updates', () => {
      const roles = ['a', 'b', 'c'];
      const ids = ['1', '2', '3', '4'];
      const currentlyPurged = {
        'a': { '1': '1', '3': '3' },
        'b': { '2': '2', '4': '4' },
        'c': {  },
      };

      const newPurged = {
        'a': { '1': true, '2': true },
        'b': { '2': true, '4': true },
        'c': { }
      };

      return service.__get__('updatePurgedDocs')(roles, ids, currentlyPurged, newPurged).then(() => {
        chai.expect(purgeDbBulkDocs.callCount).to.equal(1);
        chai.expect(purgeDbBulkDocs.args[0]).to.deep.equal([{ docs: [
          { _id: 'purged:2' },
          { _id: 'purged:3', _rev: '3', _deleted: true }
        ]}]);
      });
    });
  });

  describe('purgeContacts', () => {
    const getContactsByTypeArgs = ({ limit, id = '', key }) => ([
      'http://a:p@localhost:6500/medic/_design/medic-client/_view/contacts_by_type',
      {
        qs: {
          limit: limit,
          start_key: JSON.stringify(key ? key : (id ? `key${id}` : '')),
          startkey_docid: id,
          include_docs: true,
        },
        json: true
      }
    ]);

    let roles;
    let purgeFn;

    beforeEach(() => {
      roles = { 'a': [1, 2, 3], 'b': [4, 5, 6] };
      purgeFn = sinon.stub();
      db.couchUrl = 'http://a:p@localhost:6500/medic';
    });

    it('should grab contacts_by_type', () => {
      sinon.stub(request, 'get').resolves({ rows: [] });
      sinon.stub(db, 'get').resolves({});
      sinon.stub(db.medic, 'query').resolves({ rows: [] });

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(request.get.args[0]).to.deep.equal(getContactsByTypeArgs({ limit: 1000, id: '', key: '' }));
      });
    });

    it('should continue requesting contacts_by_type until no more new results are received', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'first', key: 'district', doc: { _id: 'first' } },
        { id: 'f1', key: 'health_center', doc: { _id: 'f1' } },
        { id: 'f2', key: 'person', doc: { _id: 'f2', patient_id: 's2' } },
        { id: 'f3', key: 'person', doc: { _id: 'f3', patient_id: 's3' } },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'f3', key: 'person', doc: { _id: 'f3', patient_id: 's3', } },
        { id: 'f4', key: 'health_center', doc: { _id: 'f4' } },
        { id: 'f5', key: 'clinic', doc: { _id: 'f5', place_id: 's5' } },
      ]});

      request.get.onCall(2).resolves({ rows: [
        { id: 'f5', key: 'clinic', doc: { _id: 'f5', place_id: 's5' } },
        { id: 'f6', key: 'district', doc: { _id: 'f6' } },
        { id: 'f7', key: 'person', doc: { _id: 'f7', patient_id: 's7' } },
        { id: 'f8', key: 'health_center', doc: { _id: 'f8', place_id: 's8' } },
      ]});

      request.get.onCall(3).resolves({ rows: [
        { id: 'f8', key: 'health_center', doc: { _id: 'f8', place_id: 's8' } },
      ]});

      sinon.stub(db.medic, 'query').resolves({ rows: [] });
      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(4);
        chai.expect(request.get.args).to.deep.equal([
          getContactsByTypeArgs({ limit: 1000, id: '', key: '' }),
          getContactsByTypeArgs({ limit: 1001, id: 'f3', key: 'person' }),
          getContactsByTypeArgs({ limit: 1001, id: 'f5', key: 'clinic' }),
          getContactsByTypeArgs({ limit: 1001, id: 'f8', key: 'health_center' }),
        ]);
      });
    });

    it('should decrease contacts batch size if the maximum number of relevant reports is received', () => {
      sinon.stub(request, 'get');
      const contacts = Array.from({ length: 1500 }).map((_, idx) => ({
        id: idx,
        key: `key${idx}`,
        doc: { _id: idx, patient_id: `key${idx}` },
      }));

      request.get.onCall(0).resolves({ rows: contacts.slice(0, 1000) });
      request.get.onCall(1).resolves({ rows: contacts.slice(0, 500) });
      request.get.onCall(2).resolves({ rows: contacts.slice(0, 250) });
      request.get.onCall(3).resolves({ rows: contacts.slice(250, 500) });
      request.get.onCall(4).resolves({ rows: contacts.slice(500, 750) });
      request.get.onCall(5).resolves({ rows: contacts.slice(750, 1000) });
      request.get.onCall(6).resolves({ rows: contacts.slice(1000, 1250) });
      request.get.onCall(7).resolves({ rows: contacts.slice(1250, 1500) });
      request.get.onCall(8).resolves({ rows: contacts.slice(1500, 1500) });

      const reports = Array.from({ length: 48000 }).map((_, idx) => ({
        id: `rec${idx}`,
        key: `key${idx}`,
        doc: { patient_id: `key${idx}`, type: 'data_record' },
      }));

      sinon.stub(db.medic, 'query');
      db.medic.query.onCall(0).resolves({ rows: reports.slice(0, 20000) });
      db.medic.query.onCall(1).resolves({ rows: reports.slice(0, 20000) });
      db.medic.query.onCall(2).resolves({ rows: reports.slice(0, 8000) });
      db.medic.query.onCall(3).resolves({ rows: reports.slice(8000, 16000) });
      db.medic.query.onCall(4).resolves({ rows: reports.slice(16000, 24000) });
      db.medic.query.onCall(5).resolves({ rows: reports.slice(24000, 32000) });
      db.medic.query.onCall(6).resolves({ rows: reports.slice(32000, 40000) });
      db.medic.query.onCall(7).resolves({ rows: reports.slice(40000, 48000) });
      db.medic.query.onCall(8).resolves({ rows: [] });

      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(9);

        chai.expect(request.get.args[0]).to.deep.equal(getContactsByTypeArgs({ limit: 1000 }));
        chai.expect(request.get.args[1]).to.deep.equal(getContactsByTypeArgs({ limit: 500 }));
        chai.expect(request.get.args[2]).to.deep.equal(getContactsByTypeArgs({ limit: 250 }));
        chai.expect(request.get.args[3]).to.deep.equal(getContactsByTypeArgs({ limit: 251, id: 249 }));
        chai.expect(request.get.args[4]).to.deep.equal(getContactsByTypeArgs({ limit: 251, id: 499 }));
        chai.expect(request.get.args[5]).to.deep.equal(getContactsByTypeArgs({ limit: 251, id: 749 }));
        chai.expect(request.get.args[6]).to.deep.equal(getContactsByTypeArgs({ limit: 251, id: 999 }));
        chai.expect(request.get.args[7]).to.deep.equal(getContactsByTypeArgs({ limit: 251, id: 1249 }));
        chai.expect(request.get.args[8]).to.deep.equal(getContactsByTypeArgs({ limit: 251, id: 1499 }));

        chai.expect(db.medic.query.callCount).to.equal(8);
        chai.expect(service.__get__('contactsBatchSize')).to.equal(250);
      });
    });

    it('should increase and decrease the batch size depending on the number of relevant reports', () => {
      sinon.stub(request, 'get');
      const contacts = Array.from({ length: 2500 }).map((_, idx) => ({
        id: idx,
        key: `key${idx}`,
        doc: { _id: idx, patient_id: `key${idx}` },
      }));

      request.get.callsFake((_, { qs: { limit, startkey_docid } }) => {
        return Promise.resolve({ rows: contacts.slice(startkey_docid, limit + startkey_docid) });
      });

      const reports = Array.from({ length: 48000 }).map((_, idx) => ({
        id: idx,
        key: `key${idx}`,
        doc: { patient_id: `key${idx}`, type: 'data_record' },
      }));

      sinon.stub(db.medic, 'query');
      db.medic.query.onCall(0).resolves({ rows: reports }); // decrease
      db.medic.query.onCall(1).resolves({ rows: reports }); // decrease
      db.medic.query.onCall(2).resolves({ rows: reports.slice(0, 8000) }); // keep
      db.medic.query.onCall(3).resolves({ rows: reports.slice(8000, 16000) }); // keep
      db.medic.query.onCall(4).resolves({ rows: reports.slice(16000, 20000) }); // increase
      db.medic.query.onCall(5).resolves({ rows: reports.slice(20000, 22000) }); // increase
      db.medic.query.onCall(6).resolves({ rows: reports.slice(22000, 23000) }); // increase
      db.medic.query.onCall(7).resolves({ rows: reports.slice(23000, 48000) }); // decrease
      db.medic.query.onCall(8).resolves({ rows: reports.slice(23000, 48000) }); // decrease
      db.medic.query.onCall(9).resolves({ rows: reports.slice(23000, 48000) }); // decrease
      db.medic.query.onCall(10).resolves({ rows: reports.slice(23000, 48000) }); // decrease
      db.medic.query.onCall(11).resolves({ rows: reports.slice(23000, 28000) }); // keep
      db.medic.query.onCall(12).resolves({ rows: reports.slice(28000, 35000) }); // keep
      db.medic.query.onCall(13).resolves({ rows: reports.slice(35000, 45000) }); // keep
      db.medic.query.onCall(14).resolves({ rows: reports.slice(45000, 46000) }); // increase
      db.medic.query.onCall(15).resolves({ rows: reports.slice(46000, 47000) }); // increase
      db.medic.query.onCall(16).resolves({ rows: reports.slice(47000, 48000) }); // increase

      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(17);

        chai.expect(request.get.args[0]).to.deep.equal(getContactsByTypeArgs({ limit: 1000 }));
        chai.expect(request.get.args[1]).to.deep.equal(getContactsByTypeArgs({ limit: 500 })); // decrease
        chai.expect(request.get.args[2]).to.deep.equal(getContactsByTypeArgs({ limit: 250 })); // decrease
        chai.expect(request.get.args[3]).to.deep.equal(getContactsByTypeArgs({ limit: 251, id: 249 })); // keep
        chai.expect(request.get.args[4]).to.deep.equal(getContactsByTypeArgs({ limit: 251, id: 499})); // keep
        chai.expect(request.get.args[5]).to.deep.equal(getContactsByTypeArgs({ limit: 501, id: 749 })); // increase
        chai.expect(request.get.args[6]).to.deep.equal(getContactsByTypeArgs({ limit: 1001, id: 1249 })); // increase
        chai.expect(request.get.args[7]).to.deep.equal(getContactsByTypeArgs({ limit: 1001, id: 2249 })); // increase
        chai.expect(request.get.args[8]).to.deep.equal(getContactsByTypeArgs({ limit: 501, id: 2249 })); // decrease
        chai.expect(request.get.args[9]).to.deep.equal(getContactsByTypeArgs({ limit: 251, id: 2249 })); // decrease
        chai.expect(request.get.args[10]).to.deep.equal(getContactsByTypeArgs({ limit: 126, id: 2249 })); // decrease
        chai.expect(request.get.args[11]).to.deep.equal(getContactsByTypeArgs({ limit: 63, id: 2249 })); // decrease
        chai.expect(request.get.args[12]).to.deep.equal(getContactsByTypeArgs({ limit: 63, id: 2311 })); // keep
        chai.expect(request.get.args[13]).to.deep.equal(getContactsByTypeArgs({ limit: 63, id: 2373 })); // keep
        chai.expect(request.get.args[14]).to.deep.equal(getContactsByTypeArgs({ limit: 63, id: 2435 })); // keep
        chai.expect(request.get.args[15]).to.deep.equal(getContactsByTypeArgs({ limit: 125, id: 2497 })); // increase
        chai.expect(request.get.args[16]).to.deep.equal(getContactsByTypeArgs({ limit: 249, id: 2499 })); // increase

        chai.expect(db.medic.query.callCount).to.equal(16);
        chai.expect(service.__get__('contactsBatchSize')).to.equal(248); // last increase is skipped (no subjects)
      });
    });

    it('should skip irrelevant reports when batching records', () => {
      sinon.stub(request, 'get');
      const contacts = Array.from({ length: 1100 }).map((_, idx) => ({
        id: idx,
        key: `key${idx}`,
        doc: { _id: idx },
      }));

      request.get.callsFake((_, { qs: { limit, startkey_docid = '' } }) => {
        startkey_docid = startkey_docid === '' ? 0 : parseInt(startkey_docid);
        return Promise.resolve({ rows: contacts.slice(startkey_docid, limit + startkey_docid) });
      });

      const getContactsIds = (start, end) => contacts.slice(start, end).map(contact => contact.id);

      const genReports = (nbrRelevant, nbr = 20000) => {
        const reports = Array.from({ length: nbrRelevant }).map((_, idx) => ({
          id: `rec${idx}`,
          key: `patient${idx}`,
          doc: { patient_id: `patient${idx}`, type: 'data_record' },
          value: { submitter: 'subm' },
        }));
        if (nbr > nbrRelevant) {
          const irrelevantReports = Array.from({ length: nbr - nbrRelevant}).map((_, idx) => ({
            id: `rec${idx}`,
            key: `random`,
            doc: { patient_id: `patient${idx}`, type: 'data_record', fields: { needs_signoff: true } },
            value: { submitter: 'subm' },
          }));
          reports.push(...irrelevantReports);
        }

        return reports;
      };

      sinon.stub(registrationUtils, 'getSubjectIds').callsFake(contact => [contact._id]);

      sinon.stub(db.medic, 'query');
      // 1st batch of 1000 contacts [0-1000]
      db.medic.query.onCall(0).resolves({ rows: genReports(5000) });
      db.medic.query.onCall(1).resolves({ rows: genReports(10000) });
      db.medic.query.onCall(2).resolves({ rows: genReports(8000) }); // we exceed 20k relevant reports
      // 1st batch of 500 contacts [0-500]
      db.medic.query.onCall(3).resolves({ rows: genReports(5000) });
      db.medic.query.onCall(4).resolves({ rows: genReports(10000) });
      db.medic.query.onCall(5).resolves({ rows: genReports(2000, 5000) }); // we don't exceed 20k relevant reports
      // 2nd batch of 500 contacts [500-1000]
      db.medic.query.onCall(6).resolves({ rows: genReports(10000) });
      db.medic.query.onCall(7).resolves({ rows: genReports(2000) });
      db.medic.query.onCall(8).resolves({ rows: genReports(5000) });
      db.medic.query.onCall(9).resolves({ rows: genReports(6000, 10000) }); // we exceed 20k relevant reports
      // 1st batch of 250 contacts [500-750]
      db.medic.query.onCall(10).resolves({ rows: genReports(2000) });
      db.medic.query.onCall(11).resolves({ rows: genReports(5000) });
      db.medic.query.onCall(12).resolves({ rows: genReports(1000, 2000) });
      // 2nd batch of 250 contacts [750-1000]
      db.medic.query.onCall(13).resolves({ rows: genReports(2000, 3000) });
      // 3nd batch of 500 contacts [1000-5000]
      db.medic.query.onCall(14).resolves({ rows: genReports(100, 200) });

      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(7);
        chai.expect(request.get.args).to.deep.equal([
          getContactsByTypeArgs({ limit: 1000 }),
          getContactsByTypeArgs({ limit: 500 }),
          getContactsByTypeArgs({ limit: 501, id: 499 }),
          getContactsByTypeArgs({ limit: 251, id: 499 }),
          getContactsByTypeArgs({ limit: 251, id: 749 }),
          getContactsByTypeArgs({ limit: 501, id: 999 }),
          getContactsByTypeArgs({ limit: 1001, id: 1099 }),
        ]);

        chai.expect(db.medic.query.callCount).to.equal(15);
        chai.expect(db.medic.query.args[0][1].keys).to.have.members(getContactsIds(0, 1000));
        chai.expect(db.medic.query.args[0][1].skip).to.equal(0);
        chai.expect(db.medic.query.args[1][1].keys).to.have.members(getContactsIds(0, 1000));
        chai.expect(db.medic.query.args[1][1].skip).to.equal(20000);
        chai.expect(db.medic.query.args[2][1].keys).to.have.members(getContactsIds(0, 1000));
        chai.expect(db.medic.query.args[2][1].skip).to.equal(40000);

        chai.expect(db.medic.query.args[3][1].keys).to.have.members(getContactsIds(0, 500));
        chai.expect(db.medic.query.args[3][1].skip).to.equal(0);
        chai.expect(db.medic.query.args[4][1].keys).to.have.members(getContactsIds(0, 500));
        chai.expect(db.medic.query.args[4][1].skip).to.equal(20000);
        chai.expect(db.medic.query.args[5][1].keys).to.have.members(getContactsIds(0, 500));
        chai.expect(db.medic.query.args[5][1].skip).to.equal(40000);

        chai.expect(db.medic.query.args[6][1].keys).to.have.members(getContactsIds(500, 1000));
        chai.expect(db.medic.query.args[6][1].skip).to.equal(0);
        chai.expect(db.medic.query.args[7][1].keys).to.have.members(getContactsIds(500, 1000));
        chai.expect(db.medic.query.args[7][1].skip).to.equal(20000);
        chai.expect(db.medic.query.args[8][1].keys).to.have.members(getContactsIds(500, 1000));
        chai.expect(db.medic.query.args[8][1].skip).to.equal(40000);
        chai.expect(db.medic.query.args[9][1].keys).to.have.members(getContactsIds(500, 1000));
        chai.expect(db.medic.query.args[9][1].skip).to.equal(60000);

        chai.expect(db.medic.query.args[10][1].keys).to.have.members(getContactsIds(500, 750));
        chai.expect(db.medic.query.args[10][1].skip).to.equal(0);
        chai.expect(db.medic.query.args[11][1].keys).to.have.members(getContactsIds(500, 750));
        chai.expect(db.medic.query.args[11][1].skip).to.equal(20000);
        chai.expect(db.medic.query.args[12][1].keys).to.have.members(getContactsIds(500, 750));
        chai.expect(db.medic.query.args[12][1].skip).to.equal(40000);

        chai.expect(db.medic.query.args[13][1].keys).to.have.members(getContactsIds(750, 1000));
        chai.expect(db.medic.query.args[13][1].skip).to.equal(0);
        chai.expect(db.medic.query.args[14][1].keys).to.have.members(getContactsIds(1000, 1100));
        chai.expect(db.medic.query.args[14][1].skip).to.equal(0);
      });
    });

    it('should skip contact if report limit reached with batch size = 1', () => {
      const contacts = Array
        .from({ length: 500 })
        .map((_, idx) => ({ id: idx, key: `key${idx}`, doc: { _id: idx }}));
      const contactsToSkip = [120, 121, 325, 409];

      const reports = Array
        .from({ length: 32000 })
        .map((_, idx) => ({ id: idx, key: `key${idx}`, doc: { patient_id: `key${idx}`, type: 'data_record' }}));

      sinon.stub(request, 'get').callsFake((_, { qs: { limit, startkey_docid } }) => {
        return Promise.resolve({ rows: contacts.slice(startkey_docid, limit + startkey_docid) });
      });
      sinon.stub(db.medic, 'query').callsFake((_, opts) => {
        if (opts['keys'].find(key => contactsToSkip.includes(key))) {
          return Promise.resolve({ rows: reports });
        }
        return Promise.resolve({ rows: reports.slice(0, 6000)}); // never increase
      });

      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(397);

        chai.expect(request.get.args.slice(0, 20)).to.deep.equal([
          getContactsByTypeArgs({ limit: 1000 }),
          getContactsByTypeArgs({ limit: 500 }),
          getContactsByTypeArgs({ limit: 250 }),
          getContactsByTypeArgs({ limit: 125 }),
          getContactsByTypeArgs({ limit: 62 }),
          getContactsByTypeArgs({ limit: 63, id: 61 }),
          getContactsByTypeArgs({ limit: 32, id: 61 }),
          getContactsByTypeArgs({ limit: 32, id: 92 }),
          getContactsByTypeArgs({ limit: 16, id: 92 }),
          getContactsByTypeArgs({ limit: 16, id: 107 }),
          getContactsByTypeArgs({ limit: 8, id: 107 }),
          getContactsByTypeArgs({ limit: 8, id: 114 }),
          getContactsByTypeArgs({ limit: 4, id: 114 }),
          getContactsByTypeArgs({ limit: 4, id: 117 }),
          getContactsByTypeArgs({ limit: 2, id: 117 }),
          getContactsByTypeArgs({ limit: 2, id: 118 }),
          getContactsByTypeArgs({ limit: 2, id: 119 }),
          getContactsByTypeArgs({ limit: 2, id: 120 }),
          getContactsByTypeArgs({ limit: 2, id: 121 }),
          getContactsByTypeArgs({ limit: 2, id: 122 }),
        ]);
        for (let i = 20; i < request.get.args.length; i++) {
          const id = 123 - 20 + i;
          chai.expect(request.get.args[i]).to.deep.equal(getContactsByTypeArgs({ limit: 2, id: id }));
        }

        chai.expect(service.__get__('contactsBatchSize')).to.equal(1);
        chai.expect(service.__get__('skippedContacts')).to.deep.equal(contactsToSkip.map(id => JSON.stringify(id)));
      });
    }).timeout(10000);

    it('should decrease batch size to 1 on subsequent queries', () => {
      const contacts = Array
        .from({ length: 1005 })
        .map((_, idx) => ({ id: idx, key: `key${idx}`, doc: { _id: idx }}));
      const reports = Array
        .from({ length: 40000 })
        .map((_, idx) => ({ id: `rec${idx}`, key: `key${idx}`, doc: { patient_id: `key${idx}`, type: 'data_record' }}));

      sinon.stub(request, 'get').callsFake((_, { qs }) => {
        const start = (qs.startkey_docid && contacts.findIndex(contact => contact.id === qs.startkey_docid)) || 0;
        return Promise.resolve({ rows: contacts.slice(start, start + qs.limit)});
      });

      sinon.stub(db.medic, 'query');
      db.medic.query.onCall(0).resolves({ rows: reports.slice(0, 2000) });
      db.medic.query.onCall(1).resolves({ rows: reports.slice(2000, 25000) });
      db.medic.query.onCall(2).resolves({ rows: reports.slice(2000, 25000) });
      db.medic.query.onCall(3).resolves({ rows: reports.slice(2000, 25000) });
      db.medic.query.onCall(4).resolves({ rows: reports.slice(2000, 25000) });
      db.medic.query.onCall(5).resolves({ rows: reports.slice(2000, 25000) });
      db.medic.query.onCall(6).resolves({ rows: reports.slice(2000, 25000) });
      db.medic.query.onCall(7).resolves({ rows: reports.slice(2000, 25000) });
      db.medic.query.onCall(8).resolves({ rows: reports.slice(2000, 25000) });
      db.medic.query.onCall(9).resolves({ rows: reports.slice(2000, 25000) });
      db.medic.query.onCall(10).resolves({ rows: reports.slice(2000, 15000) });
      db.medic.query.onCall(11).resolves({ rows: reports.slice(15000, 30000) });
      db.medic.query.onCall(12).resolves({ rows: reports.slice(30000, 35000) });
      db.medic.query.onCall(13).resolves({ rows: reports.slice(35000, 36000) });
      db.medic.query.onCall(14).resolves({ rows: reports.slice(36000, 40000) });

      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(16);
        chai.expect(request.get.args[0][1].qs.limit).to.equal(1000);
        chai.expect(request.get.args[1][1].qs.limit).to.equal(1001);
        chai.expect(request.get.args[2][1].qs.limit).to.equal(501);
        chai.expect(request.get.args[3][1].qs.limit).to.equal(251);
        chai.expect(request.get.args[4][1].qs.limit).to.equal(126);
        chai.expect(request.get.args[5][1].qs.limit).to.equal(63);
        chai.expect(request.get.args[6][1].qs.limit).to.equal(32);
        chai.expect(request.get.args[7][1].qs.limit).to.equal(16);
        chai.expect(request.get.args[8][1].qs.limit).to.equal(8);
        chai.expect(request.get.args[9][1].qs.limit).to.equal(4);
        chai.expect(request.get.args[10][1].qs.limit).to.equal(2);
        chai.expect(request.get.args[11][1].qs.limit).to.equal(2);
        chai.expect(request.get.args[12][1].qs.limit).to.equal(2);
        chai.expect(request.get.args[13][1].qs.limit).to.equal(2);
        chai.expect(request.get.args[14][1].qs.limit).to.equal(3);
        chai.expect(request.get.args[15][1].qs.limit).to.equal(5);

        chai.expect(db.medic.query.callCount).to.equal(15);
      });
    });

    it('should set correct start_key and startkey_docid when last result is a tombstone', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'first', key: 'district', doc: { _id: 'first', place_id: 'firsts' } },
        { id: 'f1', key: 'district', doc: { _id: 'f1', place_id: 's1' } },
        { id: 'f2', key: 'health_center', doc: { _id: 'f2', place_id: 's3' } },
        { id: 'f3-tombstone', key: 'health_center',
          doc: { _id: 'f3-tombstone', tombstone: { _id: 'f3', place_id: 's3' } } },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'f3-tombstone', key: 'health_center',
          doc: { _id: 'f3-tombstone', tombstone: { _id: 'f3', place_id: 's3' } } },
        { id: 'f4-tombstone', key: 'clinic', doc: { _id: 'f4-tombstone', tombstone: { _id: 'f4', place_id: 's4' } } },
        { id: 'f5', key: 'person', doc: { _id: 'f5', patient_id: 's5' } },
      ]});

      request.get.onCall(2).resolves({ rows: [
        { id: 'f5', key: 'person', doc: { _id: 'f5', patient_id: 's5' } },
        { id: 'f6-tombstone', key: 'person', doc: { _id: 'f6-tombstone', tombstone: { _id: 'f6', patient_id: 's6' } } },
        { id: 'f7', key: 'person', doc: { _id: 'f7', patient_id: 's7' } },
        { id: 'f8-tombstone', key: 'person', doc: { _id: 'f8-tombstone', tombstone: { _id: 'f8', patient_id: 's8' } } },
      ]});

      request.get.onCall(3).resolves({ rows: [
        { id: 'f8-tombstone', key: 'person', doc: { _id: 'f8-tombstone', tombstone: { _id: 'f8', patient_id: 's8' } } },
      ]});

      sinon.stub(tombstoneUtils, 'isTombstoneId').callsFake(id => id.includes('tombstone'));
      sinon.stub(tombstoneUtils, 'extractStub').callsFake(id => ({ id: id.replace('-tombstone', '') }));

      sinon.stub(db.medic, 'query').resolves({ rows: [] });
      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(4);
        chai.expect(request.get.args).to.deep.equal([
          getContactsByTypeArgs({ limit: 1000, id: '', key: '' }),
          getContactsByTypeArgs({ limit: 1001, id: 'f3-tombstone', key: 'health_center' }),
          getContactsByTypeArgs({ limit: 1001, id: 'f5', key: 'person' }),
          getContactsByTypeArgs({ limit: 1001, id: 'f8-tombstone', key: 'person' }),
        ]);
      });
    });

    it('should get all docs_by_replication_key using the retrieved contacts and purge docs', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'first', key: 'health_center', doc: { _id: 'first', type: 'district_hospital' } },
        { id: 'f1', key: 'clinic', doc: { _id: 'f1', place_id: 's1', type: 'clinic' } },
        { id: 'f2', key: 'person', doc: { _id: 'f2', type: 'person' } },
        { id: 'f4', key: 'clinic', doc: { _id: 'f4', place_id: 's4', type: 'clinic' }},
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'f4', key: 'clinic', doc: { _id: 'f4', place_id: 's4' }},
      ]});

      sinon.stub(tombstoneUtils, 'isTombstoneId').callsFake(id => id.includes('tombstone'));
      sinon.stub(registrationUtils, 'getSubjectId').callsFake(doc => doc.patient_id);

      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      sinon.stub(db.medic, 'query');
      db.medic.query.onCall(0).resolves({ rows: [
        { id: 'first', key: 'first', doc: { _id: 'first', type: 'district_hospital' }},
        { id: 'f1', key: 'f1', doc: { _id: 'f1', place_id: 's1', type: 'clinic' }},
        { id: 'f1-r1', key: 's1', doc: { _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1' } },
        { id: 'f1-m1', key: 'f1', doc: { _id: 'f1-m1', type: 'data_record', sms_message: 'a' } },
        { id: 'f1-r2', key: 's1', doc: { _id: 'f1-r2', type: 'data_record', form: 'b', patient_id: 's1' } },
        { id: 'f1-m2', key: 'f1', doc: { _id: 'f1-m2', type: 'data_record', sms_message: 'b' } },
        { id: 'f2', key: 'f2', doc: { _id: 'f2', type: 'person' }},
        { id: 'f2-r1', key: 'f2', doc: { _id: 'f2-r1', type: 'data_record', form: 'a', patient_id: 'f2' } },
        { id: 'f2-r2', key: 'f2', doc: { _id: 'f2-r2', type: 'data_record', form: 'b', patient_id: 'f2' } },
        { id: 'f4', key: 'f4', doc: { _id: 'f4', place_id: 's4', type: 'clinic' }},
        { id: 'f4-m1', key: 'f4', doc: { _id: 'f4-m1', type: 'data_record', sms_message: 'b' } },
        { id: 'f4-m2', key: 'f4', doc: { _id: 'f4-m2', type: 'data_record', sms_message: 'b' } },
      ] });

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(2);
        chai.expect(db.medic.query.callCount).to.equal(1);
        chai.expect(db.medic.query.args[0]).to.deep.equal([
          'medic/docs_by_replication_key',
          { keys: ['first', 'f1', 's1', 'f2', 'f4', 's4'], skip: 0, limit: 20000, include_docs: true },
        ]);
        chai.expect(purgeDbChanges.callCount).to.equal(2);
        chai.expect(purgeDbChanges.args[0]).to.deep.equalInAnyOrder([{
          doc_ids: [
            'purged:first',
            'purged:f1', 'purged:f1-m1', 'purged:f1-m2', 'purged:f1-r1', 'purged:f1-r2',
            'purged:f2', 'purged:f2-r1', 'purged:f2-r2',
            'purged:f4', 'purged:f4-m1', 'purged:f4-m2',
          ],
          batch_size: 13,
          seq_interval: 12
        }]);

        chai.expect(purgeDbChanges.args[1]).to.deep.equalInAnyOrder([{
          doc_ids: [
            'purged:first',
            'purged:f1', 'purged:f1-m1', 'purged:f1-m2', 'purged:f1-r1', 'purged:f1-r2',
            'purged:f2', 'purged:f2-r1', 'purged:f2-r2',
            'purged:f4', 'purged:f4-m1', 'purged:f4-m2',
          ],
          batch_size: 13,
          seq_interval: 12
        }]);

        chai.expect(purgeFn.callCount).to.equal(8);
        chai.expect(purgeFn.args[0]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'first', type: 'district_hospital' },
          [],
          []
        ]);
        chai.expect(purgeFn.args[1]).to.deep.equal([
          { roles: roles['b'] },
          { _id: 'first', type: 'district_hospital' },
          [],
          []
        ]);

        chai.expect(purgeFn.args[2]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'f1', type: 'clinic', place_id: 's1' },
          [
            { _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1' },
            { _id: 'f1-r2', type: 'data_record', form: 'b', patient_id: 's1' }
          ],
          [
            { _id: 'f1-m1', type: 'data_record', sms_message: 'a' },
            { _id: 'f1-m2', type: 'data_record', sms_message: 'b' }
          ]
        ]);
        chai.expect(purgeFn.args[3]).to.deep.equal([
          { roles: roles['b'] },
          { _id: 'f1', type: 'clinic', place_id: 's1' },
          [
            { _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1' },
            { _id: 'f1-r2', type: 'data_record', form: 'b', patient_id: 's1' }
          ],
          [
            { _id: 'f1-m1', type: 'data_record', sms_message: 'a' },
            { _id: 'f1-m2', type: 'data_record', sms_message: 'b' }
          ]
        ]);

        chai.expect(purgeFn.args[4]).to.deep.equalInAnyOrder([
          { roles: roles['a'] },
          { _id: 'f2', type: 'person' },
          [
            { _id: 'f2-r1', type: 'data_record', form: 'a', patient_id: 'f2' },
            { _id: 'f2-r2', type: 'data_record', form: 'b', patient_id: 'f2' }
          ],
          []
        ]);
        chai.expect(purgeFn.args[5]).to.deep.equalInAnyOrder([
          { roles: roles['b'] },
          { _id: 'f2', type: 'person' },
          [
            { _id: 'f2-r1', type: 'data_record', form: 'a', patient_id: 'f2' },
            { _id: 'f2-r2', type: 'data_record', form: 'b', patient_id: 'f2' }
          ],
          []
        ]);

        chai.expect(purgeFn.args[6]).to.deep.equalInAnyOrder([
          { roles: roles['a'] },
          { _id: 'f4', type: 'clinic', place_id: 's4' },
          [],
          [
            { _id: 'f4-m1', type: 'data_record', sms_message: 'b' },
            { _id: 'f4-m2', type: 'data_record', sms_message: 'b' }
          ]
        ]);
        chai.expect(purgeFn.args[7]).to.deep.equalInAnyOrder([
          { roles: roles['b'] },
          { _id: 'f4', type: 'clinic', place_id: 's4' },
          [],
          [
            { _id: 'f4-m1', type: 'data_record', sms_message: 'b' },
            { _id: 'f4-m2', type: 'data_record', sms_message: 'b' }
          ]
        ]);
      });
    });

    it('should correctly group messages and reports for tombstones and tombstoned reports', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'first', key: 'district_hospital', doc: { _id: 'first', type: 'district_hospital' } },
        { id: 'f1-tombstone', key: 'clinic',
          doc: { _id: 'f1-tombstone', tombstone: { _id: 'f1', type: 'clinic', place_id: 's1'  } } },
        { id: 'f2-tombstone', key: 'person',
          doc: { _id: 'f2-tombstone', tombstone: { _id: 'f2', type: 'person' } } },
        { id: 'f3', key: 'health_center', doc: { _id: 'f3', type: 'health_center' } },
        { id: 'f4-tombstone', key: 'person',
          doc: { _id: 'f4-tombstone', tombstone: { _id: 'f4', type: 'person', patient_id: 's4' } } },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'f4-tombstone', key: 'person',
          doc: { _id: 'f4-tombstone', tombstone: { _id: 'f4', type: 'person', patient_id: 's4' } } },
      ]});

      sinon.stub(tombstoneUtils, 'isTombstoneId').callsFake(id => id.includes('tombstone'));
      sinon.stub(tombstoneUtils, 'extractStub').callsFake(id => ({ id: id.replace('-tombstone', '') }));
      sinon.stub(registrationUtils, 'getSubjectId').callsFake(doc => doc.patient_id);

      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      sinon.stub(db.medic, 'query');
      db.medic.query.onCall(0).resolves({ rows: [
        { id: 'first', key: 'first', doc: { _id: 'first', type: 'district_hospital' }},
        { id: 'f1-tombstone', key: 'f1',
          doc: { _id: 'f1-tombstone', tombstone: { _id: 'f1', type: 'clinic', place_id: 's1'  } } },
        { id: 'f1-r1', key: 's1', doc: { _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1' } },
        { id: 'f1-m1', key: 'f1', doc: { _id: 'f1-m1', type: 'data_record', sms_message: 'a' } },
        { id: 'f1-r2', key: 's1', doc: { _id: 'f1-r2', type: 'data_record', form: 'b', patient_id: 's1' } },
        { id: 'f1-m2', key: 'f1', doc: { _id: 'f1-m2', type: 'data_record', sms_message: 'b' } },
        { id: 'f2-tombstone', key: 'f2',
          doc: { _id: 'f1-tombstone', tombstone: { _id: 'f1', type: 'clinic', place_id: 's1'  } }},
        { id: 'f2-r1', key: 'f2', doc: { _id: 'f2-r1', type: 'data_record', form: 'a', patient_id: 'f2' } },
        { id: 'f2-r2', key: 'f2', doc: { _id: 'f2-r2', type: 'data_record', sms_message: 'b' } },
        { id: 'f3', key: 'f3', doc: { _id: 'f3', type: 'health_center' }},
        { id: 'f3-m1-tombstone', key: 'f3', doc: { _id: 'f3-m1-tombstone', type: 'tombstone' } },
        { id: 'f3-r1-tombstone', key: 'f3', doc: { _id: 'f3-r1-tombstone', type: 'tombstone' } },
        { id: 'f3-m2', key: 'f3', doc: { _id: 'f3-m2', type: 'data_record', sms_message: 'b' } },
        { id: 'f3-r2', key: 'f3', doc: { _id: 'f3-r2', type: 'data_record', sms_message: 'b' } },
        { id: 'f4-tombstone', key: 'f4',
          doc: { _id: 'f4-tombstone', tombstone: { _id: 'f4', type: 'person', patient_id: 's4' } }},
      ] });

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(2);
        chai.expect(db.medic.query.callCount).to.equal(1);
        chai.expect(db.medic.query.args[0]).to.deep.equalInAnyOrder([
          'medic/docs_by_replication_key',
          { keys: ['first', 'f1', 's1', 'f2', 'f3', 'f4', 's4'], skip: 0, limit: 20000, include_docs: true }
        ]);
        chai.expect(purgeDbChanges.callCount).to.equal(2);
        chai.expect(purgeDbChanges.args[0]).to.deep.equalInAnyOrder([{
          doc_ids: [
            'purged:first',
            'purged:f1-m1', 'purged:f1-m2', 'purged:f1-r1', 'purged:f1-r2',
            'purged:f2-r2', 'purged:f2-r1',
            'purged:f3', 'purged:f3-m2', 'purged:f3-r2'
          ],
          batch_size: 11,
          seq_interval: 10
        }]);

        chai.expect(purgeDbChanges.args[1]).to.deep.equalInAnyOrder([{
          doc_ids: [
            'purged:first',
            'purged:f1-m1', 'purged:f1-m2', 'purged:f1-r1', 'purged:f1-r2',
            'purged:f2-r2', 'purged:f2-r1',
            'purged:f3', 'purged:f3-m2', 'purged:f3-r2'
          ],
          batch_size: 11,
          seq_interval: 10
        }]);

        chai.expect(purgeFn.callCount).to.equal(8);
        chai.expect(purgeFn.args[0]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'first', type: 'district_hospital' },
          [],
          []
        ]);

        chai.expect(purgeFn.args[2]).to.deep.equal([
          { roles: roles['a'] },
          { _deleted: true },
          [
            { _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1' },
            { _id: 'f1-r2', type: 'data_record', form: 'b', patient_id: 's1' }
          ],
          [
            { _id: 'f1-m1', type: 'data_record', sms_message: 'a' },
            { _id: 'f1-m2', type: 'data_record', sms_message: 'b' }
          ]
        ]);

        chai.expect(purgeFn.args[4]).to.deep.equal([
          { roles: roles['a'] },
          { _deleted: true },
          [{ _id: 'f2-r1', type: 'data_record', form: 'a', patient_id: 'f2' }],
          [{ _id: 'f2-r2', type: 'data_record', sms_message: 'b' }]
        ]);

        chai.expect(purgeFn.args[6]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'f3', type: 'health_center' },
          [],
          [
            { _id: 'f3-m2', type: 'data_record', sms_message: 'b' },
            { _id: 'f3-r2', type: 'data_record', sms_message: 'b' }
          ]
        ]);
      });
    });

    it('should correctly group reports that emit their submitter', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'first', key: 'first', doc: { _id: 'first', type: 'district_hospital' } },
        { id: 'f1', key: 'clinic', doc: { _id: 'f1', type: 'clinic', place_id: 's1' } },
        { id: 'f2', key: 'person', doc: { _id: 'f2', type: 'person', patient_id: 's2' } },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'f2', key: 'person', doc: { _id: 'f2', type: 'person', patient_id: 's2' } },
      ]});

      sinon.stub(tombstoneUtils, 'isTombstoneId').callsFake(id => id.includes('tombstone'));
      sinon.stub(registrationUtils, 'getSubjectId').callsFake(doc => doc.patient_id || doc.place_id);

      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      sinon.stub(db.medic, 'query');
      db.medic.query.onCall(0).resolves({ rows: [
        { id: 'first', key: 'first', doc: { _id: 'first', type: 'district_hospital' }},
        { id: 'f1', key: 'f1', doc: { _id: 'f1', type: 'clinic', place_id: 's1' }},
        { id: 'f1-r1', key: 's1', doc: { _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1' } },
        { id: 'f1-m1', key: 'f1', doc: { _id: 'f1-m1', type: 'data_record', sms_message: 'a' } },
        { id: 'f2', key: 'f2', doc: { _id: 'f2', type: 'person', patient_id: 's2' }},
        { id: 'f2-r1', key: 'f2', doc: { _id: 'f2-r1', type: 'data_record', form: 'a' } },
        { id: 'f2-r2', key: 'f2', doc: { _id: 'f2-r2', type: 'data_record', form: 'b' } },
        { id: 'f2-r3', key: 's2', doc: { _id: 'f2-r3', type: 'data_record', form: 'a', patient_id: 's2' } },
        { id: 'f2-m1', key: 'f2', doc: { _id: 'f2-m1', type: 'data_record' } },
      ] });

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(2);
        chai.expect(db.medic.query.callCount).to.equal(1);
        chai.expect(db.medic.query.args[0]).to.deep.equalInAnyOrder([
          'medic/docs_by_replication_key',
          { keys: ['first', 'f1', 's1', 'f2', 's2'], skip: 0, limit: 20000, include_docs: true }
        ]);
        chai.expect(purgeDbChanges.callCount).to.equal(2);
        chai.expect(purgeDbChanges.args[0]).to.deep.equalInAnyOrder([{
          doc_ids: [
            'purged:first',
            'purged:f1', 'purged:f1-m1', 'purged:f1-r1',
            'purged:f2', 'purged:f2-m1', 'purged:f2-r3', 'purged:f2-r1', 'purged:f2-r2',
          ],
          batch_size: 10,
          seq_interval: 9
        }]);

        chai.expect(purgeFn.callCount).to.equal(10);
        chai.expect(purgeFn.args[0]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'first', type: 'district_hospital' },
          [],
          []
        ]);

        chai.expect(purgeFn.args[2]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'f1', type: 'clinic', place_id: 's1' },
          [{ _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1' }],
          [{ _id: 'f1-m1', type: 'data_record', sms_message: 'a' }]
        ]);

        chai.expect(purgeFn.args[4]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'f2', type: 'person', patient_id: 's2' },
          [{ _id: 'f2-r3', type: 'data_record', form: 'a', patient_id: 's2' }],
          [{ _id: 'f2-m1', type: 'data_record' }]
        ]);

        chai.expect(purgeFn.args[6]).to.deep.equal([
          { roles: roles['a'] },
          {},
          [{ _id: 'f2-r1', type: 'data_record', form: 'a' }],
          []
        ]);

        chai.expect(purgeFn.args[8]).to.deep.equal([
          { roles: roles['a'] },
          {},
          [{ _id: 'f2-r2', type: 'data_record', form: 'b' }],
          []
        ]);
      });
    });

    it('should correctly ignore reports with needs_signoff when they emit submitter lineage', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'first', key: 'district_hospital', doc: { _id: 'first', type: 'district_hospital' } },
        { id: 'f1', key: 'clinic', doc: { _id: 'f1', type: 'clinic', place_id: 's1' } },
        { id: 'f2', key: 'person', doc: { _id: 'f2', type: 'person' } },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'f2', key: 'person', doc: { _id: 'f2', type: 'person' } },
      ]});

      sinon.stub(tombstoneUtils, 'isTombstoneId').callsFake(id => id.includes('tombstone'));
      sinon.stub(registrationUtils, 'getSubjectId').callsFake(doc => doc.patient_id);

      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      sinon.stub(db.medic, 'query').resolves({ rows: [
        { id: 'first', key: 'first', doc: { _id: 'first', type: 'district_hospital' } },
        { id: 'f1', key: 'f1', doc: { _id: 'f1', type: 'clinic', place_id: 's1' } },
        { id: 'f1-r1', key: 's1',
          doc: { _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1', fields: { needs_signoff: true } },
          value: { },
        },
        { id: 'f1-m1', key: 'f1', doc: { _id: 'f1-m1', type: 'data_record', sms_message: 'a' } },
        { id: 'f2', key: 'f2', doc: { _id: 'f2', type: 'person' } },
        { id: 'f2-r1', key: 'f2',
          doc: { _id: 'f2-r1', type: 'data_record', form: 'a', patient_id: 'random', fields: { needs_signoff: true } },
          value: { submitter: 'f2' },
        },
        { id: 'f2-r2', key: 'f2',
          doc: { _id: 'f2-r2', type: 'data_record', form: 'b', patient_id: 'random', fields: { needs_signoff: true } },
          value: { submitter: 'other' },
        },
        { id: 'f2-r3', key: 'f2',
          doc: { _id: 'f2-r3', type: 'data_record', form: 'a', fields: { needs_signoff: true } },
          value: { submitter: 'f2' },
        },
        { id: 'f2-r4', key: 'f2',
          doc: { _id: 'f2-r4', type: 'data_record', form: 'a', fields: { needs_signoff: true } },
          value: { submitter: 'other' },
        },
        { id: 'f2-r5', key: 'f2',
          doc: {
            _id: 'f2-r5',
            type: 'data_record',
            form: 'a',
            fields: { needs_signoff: true },
            errors: [{ code:  'registration_not_found' }]
          },
          value: { submitter: 'f2' },
        },
      ] });

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(2);
        chai.expect(db.medic.query.callCount).to.equal(1);
        chai.expect(db.medic.query.args[0]).to.deep.equal([
          'medic/docs_by_replication_key',
          { keys: ['first', 'f1', 's1', 'f2'], skip: 0, limit: 20000, include_docs: true }
        ]);
        chai.expect(purgeDbChanges.callCount).to.equal(2);
        chai.expect(purgeDbChanges.args[0]).to.deep.equalInAnyOrder([{
          doc_ids: [
            'purged:first',
            'purged:f1', 'purged:f1-m1',  'purged:f1-r1',
            'purged:f2', 'purged:f2-r3', 'purged:f2-r5'
          ],
          batch_size: 8,
          seq_interval: 7,
        }]);

        chai.expect(purgeFn.callCount).to.equal(10);
        chai.expect(purgeFn.args[0]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'first', type: 'district_hospital' },
          [],
          []
        ]);

        chai.expect(purgeFn.args[2]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'f1', type: 'clinic', place_id: 's1' },
          [{ _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1', fields: { needs_signoff: true } }],
          [{ _id: 'f1-m1', type: 'data_record', sms_message: 'a' }]
        ]);

        chai.expect(purgeFn.args[4]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'f2', type: 'person' },
          [],
          []
        ]);

        chai.expect(purgeFn.args[6]).to.deep.equal([
          { roles: roles['a'] },
          {},
          [{ _id: 'f2-r3', type: 'data_record', form: 'a', fields: { needs_signoff: true } }],
          []
        ]);

        chai.expect(purgeFn.args[8]).to.deep.equal([
          { roles: roles['a'] },
          {},
          [{
            _id: 'f2-r5',
            type: 'data_record',
            form: 'a',
            fields: { needs_signoff: true },
            errors: [{ code:  'registration_not_found' }]
          }],
          []
        ]);
      });
    });

    it('should purge existent and new docs correctly and remove old purges', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'first', key: 'district_hospital', doc: { _id: 'first', type: 'district_hospital' } },
        { id: 'f1', key: 'clinic', doc: { _id: 'f1', type: 'clinic', place_id: 's1' } },
        { id: 'f2', key: 'person', doc: { _id: 'f2', type: 'person' } },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'f2', value: null },
      ]});

      sinon.stub(tombstoneUtils, 'isTombstoneId').callsFake(id => id.includes('tombstone'));
      sinon.stub(registrationUtils, 'getSubjectId').callsFake(doc => doc.patient_id);

      sinon.stub(db.medic, 'query');
      db.medic.query.onCall(0).resolves({ rows: [
        { id: 'first', key: 'first', doc: { _id: 'first', type: 'district_hospital' } },
        { id: 'f1', key: 'f1', doc: { _id: 'f1', type: 'clinic' } },
        { id: 'f1-r1', key: 's1', doc: { _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1' } },
        { id: 'f1-m1', key: 'f1', doc: { _id: 'f1-m1', type: 'data_record', sms_message: 'a' } },
        { id: 'f2', key: 'f2', doc: { _id: 'f2', type: 'person' } },
        { id: 'f2-r1', key: 'f2', doc: { _id: 'f2-r1', type: 'data_record', form: 'a', patient_id: 'f2' } },
        { id: 'f2-r2', key: 'f2', doc: { _id: 'f2-r2', type: 'data_record', form: 'b', patient_id: 'f2' } },
        { id: 'f2-m1', key: 'f2', doc: { _id: 'f2-m1', type: 'data_record' } },
        { id: 'f2-r3', key: 'f2', doc: { _id: 'f2-r3', type: 'data_record', form: 'a', patient_id: 'f2' } },
      ] });

      const dbA = { changes: sinon.stub(), bulkDocs: sinon.stub().resolves([]) };
      const dbB = { changes: sinon.stub(), bulkDocs: sinon.stub().resolves([]) };
      dbA.changes.resolves({
        results: [
          { id: 'purged:f1-r1', changes: [{ rev: '1' }] },
          { id: 'purged:f2-r2', changes: [{ rev: '2' }], deleted: true },
          { id: 'purged:f2-r3', changes: [{ rev: '2' }]}
        ]
      });
      dbB.changes.resolves({
        results: [
          { id: 'purged:f1-m1', changes: [{ rev: '1' }] },
          { id: 'purged:f2-r1', changes: [{ rev: '2' }], deleted: true },
          { id: 'purged:f2-m1', changes: [{ rev: '2' }]}
        ]
      });
      sinon.stub(db, 'get')
        .onCall(0).returns(dbA)
        .onCall(1).returns(dbB);

      purgeFn.withArgs({ roles: roles['a'] }, { _id: 'first', type: 'district_hospital' }).returns([]);
      purgeFn.withArgs({ roles: roles['b'] }, { _id: 'first', type: 'district_hospital' }).returns([]);
      purgeFn.withArgs({ roles: roles['a'] }, { _id: 'f1', type: 'clinic', place_id: 's1' }).returns(['f1-m1']);
      purgeFn.withArgs({ roles: roles['b'] }, { _id: 'f1', type: 'clinic', place_id: 's1' })
        .returns(['f1-m1', 'f1-r1']);
      purgeFn.withArgs({ roles: roles['a'] }, { _id: 'f2', type: 'person' }).returns(['f2-m1', 'f2-r1']);
      purgeFn.withArgs({ roles: roles['b'] }, { _id: 'f2', type: 'person' }).returns(['f2-r1']);

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(dbA.changes.callCount).to.equal(1);
        chai.expect(dbA.changes.args[0]).to.deep.equalInAnyOrder([{
          doc_ids: [
            'purged:first',
            'purged:f1', 'purged:f1-m1', 'purged:f1-r1',
            'purged:f2', 'purged:f2-m1', 'purged:f2-r1', 'purged:f2-r2', 'purged:f2-r3',
          ],
          batch_size: 10,
          seq_interval: 9
        }]);

        chai.expect(dbB.changes.callCount).to.equal(1);
        chai.expect(dbB.changes.args[0]).to.deep.equalInAnyOrder([{
          doc_ids: [
            'purged:first',
            'purged:f1', 'purged:f1-m1', 'purged:f1-r1',
            'purged:f2', 'purged:f2-m1', 'purged:f2-r1', 'purged:f2-r2', 'purged:f2-r3',
          ],
          batch_size: 10,
          seq_interval: 9
        }]);

        chai.expect(purgeFn.callCount).to.equal(6);

        chai.expect(dbA.bulkDocs.callCount).to.equal(1);
        chai.expect(dbA.bulkDocs.args[0]).to.deep.equalInAnyOrder([{ docs: [
          { _id: 'purged:f1-m1' },
          { _id: 'purged:f1-r1', _deleted: true, _rev: '1' },
          { _id: 'purged:f2-m1' },
          { _id: 'purged:f2-r1' },
          { _id: 'purged:f2-r3', _deleted: true, _rev: '2' },
        ]}]);
        chai.expect(dbB.bulkDocs.callCount).to.equal(1);
        chai.expect(dbB.bulkDocs.args[0]).to.deep.equalInAnyOrder([{ docs: [
          { _id: 'purged:f1-r1' },
          { _id: 'purged:f2-m1', _deleted: true, _rev: '2' },
          { _id: 'purged:f2-r1' },
        ]}]);
      });
    });

    it('should not allow random ids from being purged', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'first', key: 'district_hospital', doc: { _id: 'first', type: 'district_hospital' } },
        { id: 'f1', key: 'clinic', doc: { _id: 'f1', type: 'clinic', place_id: 's1' } },
        { id: 'f2', key: 'clinic', doc: { _id: 'f2', type: 'clinic' } },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'f2', key: 'clinic', doc: { _id: 'f2', type: 'clinic' } },
      ]});

      sinon.stub(tombstoneUtils, 'isTombstoneId').callsFake(id => id.includes('tombstone'));
      sinon.stub(registrationUtils, 'getSubjectId').callsFake(doc => doc.patient_id);

      sinon.stub(db.medic, 'query');
      db.medic.query.onCall(0).resolves({ rows: [
        { id: 'first', key: 'first', doc: { _id: 'first', type: 'district_hospital' } },
        { id: 'f1', key: 'f1', doc: { _id: 'f1', type: 'clinic', place_id: 's1' } },
        { id: 'f1-r1', key: 's1', doc: { _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1' } },
        { id: 'f1-m1', key: 'f1', doc: { _id: 'f1-m1', type: 'data_record', sms_message: 'a' } },
        { id: 'f2', key: 'f2', doc: { _id: 'f2', type: 'clinic' }},
      ] });

      const dbA = { changes: sinon.stub().resolves({ results: [] }), bulkDocs: sinon.stub().resolves([])};
      const dbB = { changes: sinon.stub().resolves({ results: [] }), bulkDocs: sinon.stub().resolves([])};
      sinon.stub(db, 'get')
        .onCall(0).returns(dbA)
        .onCall(1).returns(dbB);

      purgeFn.withArgs({ roles: roles['a'] }, { _id: 'first', type: 'district_hospital' }).returns(['a', 'b']);
      purgeFn.withArgs({ roles: roles['b'] }, { _id: 'first', type: 'district_hospital' }).returns(['c', 'd']);
      purgeFn.withArgs({ roles: roles['a'] }, { _id: 'f1', type: 'clinic', place_id: 's1' }).returns(['f1-m1']);
      purgeFn.withArgs({ roles: roles['b'] }, { _id: 'f1', type: 'clinic', place_id: 's1' })
        .returns(['f1-m1', 'random']);
      purgeFn.withArgs({ roles: roles['a'] }, { _id: 'f2', type: 'clinic' }).returns(['f2-m1']);
      purgeFn.withArgs({ roles: roles['b'] }, { _id: 'f2', type: 'clinic' }).returns(['f2']);

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(dbA.changes.callCount).to.equal(1);
        chai.expect(dbA.changes.args[0]).to.deep.equalInAnyOrder([{
          doc_ids: ['purged:first', 'purged:f1', 'purged:f1-r1', 'purged:f1-m1', 'purged:f2',  ],
          batch_size: 6,
          seq_interval: 5
        }]);

        chai.expect(dbB.changes.callCount).to.equal(1);
        chai.expect(dbB.changes.args[0]).to.deep.equalInAnyOrder([{
          doc_ids: ['purged:first', 'purged:f1', 'purged:f1-m1', 'purged:f1-r1', 'purged:f2',  ],
          batch_size: 6,
          seq_interval: 5
        }]);

        chai.expect(purgeFn.callCount).to.equal(6);
        chai.expect(purgeFn.args[0]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'first', type: 'district_hospital' },
          [],
          []
        ]);

        chai.expect(purgeFn.args[2]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'f1', type: 'clinic', place_id: 's1' },
          [{ _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1' }],
          [{ _id: 'f1-m1', type: 'data_record', sms_message: 'a' }]
        ]);

        chai.expect(purgeFn.args[4]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'f2', type: 'clinic' },
          [],
          []
        ]);

        chai.expect(dbA.bulkDocs.callCount).to.equal(1);
        chai.expect(dbA.bulkDocs.args[0]).to.deep.equal([{ docs: [{ _id: 'purged:f1-m1' }] }]);
        chai.expect(dbB.bulkDocs.callCount).to.equal(1);
        chai.expect(dbB.bulkDocs.args[0]).to.deep.equal([{ docs: [{ _id: 'purged:f1-m1' }, { _id: 'purged:f2' } ] }]);
      });
    });

    it('should handle random results from purgefn', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'first', key: 'district_hospital', doc: { _id: 'first', type: 'district_hospital' } },
        { id: 'f1', key: 'clinic', doc: { _id: 'f1', type: 'clinic' } },
        { id: 'f2', key: 'clinic', doc: { _id: 'f2', type: 'clinic' } },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'f2', key: 'clinic', doc: { _id: 'f2', type: 'clinic' } },
      ]});

      sinon.stub(tombstoneUtils, 'isTombstoneId').callsFake(id => id.includes('tombstone'));
      sinon.stub(registrationUtils, 'getSubjectId').callsFake(doc => doc.patient_id);

      sinon.stub(db.medic, 'query');
      db.medic.query.onCall(0).resolves({ rows: [
        { id: 'first', key: 'first', doc: { _id: 'first', type: 'district_hospital' }},
        { id: 'f1', key: 'f1', doc: { _id: 'f1', type: 'clinic' }},
        { id: 'f1-r1', key: 's1', doc: { _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1' } },
        { id: 'f1-m1', key: 'f1', doc: { _id: 'f1-m1', type: 'data_record', sms_message: 'a' } },
        { id: 'f2', key: 'f2', doc: { _id: 'f2', type: 'clinic' }},
      ] });
      db.medic.query.onCall(1).resolves({ rows: [] });

      const dbA = {
        changes: sinon.stub().resolves({ results: [ { id: 'purged:f1-m1', changes: [{ rev: '1' }] } ] }),
        bulkDocs: sinon.stub().resolves([])
      };
      const dbB = {
        changes: sinon.stub().resolves({ results: [] }),
        bulkDocs: sinon.stub().resolves([])
      };
      sinon.stub(db, 'get')
        .onCall(0).returns(dbA)
        .onCall(1).returns(dbB);

      purgeFn.withArgs({ roles: roles['a'] }, { _id: 'first', type: 'district_hospital' }).returns('string');
      purgeFn.withArgs({ roles: roles['b'] }, { _id: 'first', type: 'district_hospital' }).returns({});
      purgeFn.withArgs({ roles: roles['a'] }, { _id: 'f1', type: 'clinic' }).returns([]);
      purgeFn.withArgs({ roles: roles['b'] }, { _id: 'f1', type: 'clinic' }).returns(23);
      purgeFn.withArgs({ roles: roles['a'] }, { _id: 'f2', type: 'clinic' }).returns(false);
      purgeFn.withArgs({ roles: roles['b'] }, { _id: 'f2', type: 'clinic' }).returns(null);

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(dbA.bulkDocs.callCount).to.equal(1);
        chai.expect(dbA.bulkDocs.args[0]).to.deep.equal([{docs: [{_id: 'purged:f1-m1', _rev: '1', _deleted: true}]}]);
        chai.expect(dbB.bulkDocs.callCount).to.equal(0);
      });
    });

    it('should skip any other types than data_records', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'first', key: 'district_hospital', doc: { _id: 'first', type: 'district_hospital' } },
        { id: 'f1', key: 'clinic', doc: { _id: 'f1', type: 'clinic', place_id: 's1' } },
        { id: 'f2', key: 'person', doc: { _id: 'f2', type: 'person' } },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'f2', key: 'person', doc: { _id: 'f2', type: 'person' } },
      ]});

      sinon.stub(registrationUtils, 'getSubjectId').callsFake(doc => doc.patient_id);
      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      sinon.stub(db.medic, 'query');
      db.medic.query.onCall(0).resolves({ rows: [
        { id: 'first', key: 'first', doc: { _id: 'first', type: 'district_hospital' } },
        { id: 'f1', key: 'f1', doc: { _id: 'f1', type: 'clinic', place_id: 's1' } },
        { id: 'target~one', key: 's1', doc: { _id: 'target~one', type: 'target', owner: 's1' } },
        { id: 'random~two', key: 'f2', doc: { _id: 'random~two', type: 'random2', form: 'a', contact: 'other' } },
        { id: 'f1-r1', key: 's1',
          doc: { _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1' } },
        { id: 'f1-m1', key: 'f1', doc: { _id: 'f1-m1', type: 'data_record', sms_message: 'a' } },
        { id: 'f2', key: 'f2', doc: { _id: 'f2', type: 'person' } },
        { id: 'target~two', key: 'f2', doc: { _id: 'target~two', type: 'target', owner: 'f2' } },
        { id: 'random~one', key: 'f2', doc: { _id: 'random~one', type: 'random', form: 'a', contact: { _id: 'f2' } } },

      ] });

      return service.__get__('purgeContacts')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(2);
        chai.expect(db.medic.query.callCount).to.equal(1);
        chai.expect(db.medic.query.args[0]).to.deep.equalInAnyOrder([
          'medic/docs_by_replication_key',
          { keys: ['first', 'f1', 's1', 'f2'], skip: 0, limit: 20000, include_docs: true }
        ]);
        chai.expect(purgeDbChanges.callCount).to.equal(2);
        chai.expect(purgeDbChanges.args[0]).to.deep.equalInAnyOrder([{
          doc_ids: [
            'purged:first',
            'purged:f1', 'purged:f1-m1',  'purged:f1-r1',
            'purged:f2',
          ],
          batch_size: 6,
          seq_interval: 5
        }]);

        chai.expect(purgeFn.callCount).to.equal(6);
        chai.expect(purgeFn.args[0]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'first', type: 'district_hospital' },
          [],
          []
        ]);

        chai.expect(purgeFn.args[2]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'f1', type: 'clinic', place_id: 's1' },
          [{ _id: 'f1-r1', type: 'data_record', form: 'a', patient_id: 's1' }],
          [{ _id: 'f1-m1', type: 'data_record', sms_message: 'a' }]
        ]);

        chai.expect(purgeFn.args[4]).to.deep.equal([
          { roles: roles['a'] },
          { _id: 'f2', type: 'person' },
          [],
          []
        ]);
      });
    });

    it('should throw contacts_by_type errors', () => {
      sinon.stub(request, 'get').rejects({ some: 'err' });
      sinon.stub(db, 'get').resolves({});
      sinon.stub(db.medic, 'query');

      return service.__get__('purgeContacts')(roles, purgeFn).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(err).to.deep.equal({some: 'err'});
        chai.expect(db.medic.query.callCount).to.equal(0);
      });
    });

    it('should throw docs_by_replication_key errors ', () => {
      sinon.stub(request, 'get').resolves({ rows: [{ id: 'first', key: 'district_hospital', doc: { _id: 'first' } }]});
      sinon.stub(db.medic, 'query').rejects({ some: 'err' });

      return service.__get__('purgeContacts')(roles, purgeFn).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(db.medic.query.callCount).to.equal(1);
        chai.expect(err).to.deep.equal({some: 'err'});
      });
    });

    it('should throw purgedb changes errors', () => {
      sinon.stub(request, 'get').resolves({ rows: [{ id: 'first', key: 'district_hospital', doc: { _id: 'first' } }]});
      sinon.stub(db.medic, 'query').resolves({ rows: [{ id: 'first', doc: { _id: 'first' } }] });
      const purgeDbChanges = sinon.stub().rejects({ some: 'err' });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      return service.__get__('purgeContacts')(roles, purgeFn).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(db.medic.query.callCount).to.equal(1);
        chai.expect(err).to.deep.equal({ some: 'err' });
      });
    });

    it('should throw purgefn errors', () => {
      sinon.stub(request, 'get').resolves({ rows: [{ id: 'first', key: 'district_hospital', doc: { _id: 'first' } }]});
      sinon.stub(db.medic, 'query').resolves({ rows: [{ id: 'first', doc: { _id: 'first' } }] });
      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });
      purgeFn.throws(new Error('error'));

      return service.__get__('purgeContacts')(roles, purgeFn).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(db.medic.query.callCount).to.equal(1);
        chai.expect(purgeDbChanges.callCount).to.equal(2);
        chai.expect(err.message).to.deep.equal('error');
      });
    });

    it('should throw purgedb _bulk_docs errors', () => {
      sinon.stub(request, 'get').resolves({ rows: [{ id: 'first', key: 'district_hospital', doc: { _id: 'first' } }]});
      sinon.stub(db.medic, 'query').resolves({ rows: [{ id: 'first', doc: { _id: 'first' } }] });
      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub().rejects({ some: 'err' }) });
      purgeFn.returns(['first']);

      return service.__get__('purgeContacts')(roles, purgeFn).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(db.medic.query.callCount).to.equal(1);
        chai.expect(purgeDbChanges.callCount).to.equal(2);
        chai.expect(purgeFn.callCount).to.equal(2);
        chai.expect(err).to.deep.equal({ some: 'err' });
      });
    });
  });

  describe('purgeUnallocatedRecords', () => {
    let roles;
    let purgeFn;

    beforeEach(() => {
      roles = { 'a': [1, 2, 3], 'b': [4, 5, 6] };
      purgeFn = sinon.stub();
      db.couchUrl = 'http://a:p@localhost:6500/medic';
    });

    it('should request first batch', () => {
      sinon.stub(request, 'get').resolves({ rows:[] });
      return service.__get__('purgeUnallocatedRecords')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(request.get.args[0]).to.deep.equal([
          {
            url: 'http://a:p@localhost:6500/medic/_design/medic/_view/docs_by_replication_key',
            qs: {
              limit: 20000,
              key: JSON.stringify('_unassigned'),
              startkey_docid: '',
              include_docs: true
            },
            json: true
          }
        ]);
      });
    });

    it('should stop after no longer getting results', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'r1', doc: { _id: 'r1', form: 'a' } },
        { id: 'r2', doc: { _id: 'r2', form: 'a' } },
        { id: 'r3', doc: { _id: 'r3' } },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'r3', doc: { _id: 'r3' } },
        { id: 'r4', doc: { _id: 'r4', form: 'a' } },
        { id: 'r5', doc: { _id: 'r5' } },
      ]});

      request.get.onCall(2).resolves({ rows: [
        { id: 'r5', doc: { _id: 'r5' } },
      ]});

      sinon.stub(db, 'get').returns({ changes: sinon.stub().resolves({ results: [] }) });

      return service.__get__('purgeUnallocatedRecords')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(3);
        chai.expect(request.get.args[0]).to.deep.equal([
          {
            url: 'http://a:p@localhost:6500/medic/_design/medic/_view/docs_by_replication_key',
            qs: {
              limit: 20000,
              key: JSON.stringify('_unassigned'),
              startkey_docid: '',
              include_docs: true
            },
            json: true
          }]);

        chai.expect(request.get.args[1]).to.deep.equal([
          {
            url: 'http://a:p@localhost:6500/medic/_design/medic/_view/docs_by_replication_key',
            qs: {
              limit: 20000,
              key: JSON.stringify('_unassigned'),
              startkey_docid: 'r3',
              include_docs: true
            },
            json: true
          }]);

        chai.expect(request.get.args[2]).to.deep.equal([
          {
            url: 'http://a:p@localhost:6500/medic/_design/medic/_view/docs_by_replication_key',
            qs: {
              limit: 20000,
              key: JSON.stringify('_unassigned'),
              startkey_docid: 'r5',
              include_docs: true
            },
            json: true
          }]);
      });
    });

    it('should run purge function over every doc individually', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'r1', doc: { _id: 'r1', form: 'a' } },
        { id: 'r2', doc: { _id: 'r2', form: 'a' } },
        { id: 'r3', doc: { _id: 'r3' } },
        { id: 'r4', doc: { _id: 'r4', form: 'a' } },
        { id: 'r5', doc: { _id: 'r5' } },
        { id: 'r6', doc: { _id: 'r6', form: 'a' } },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'r6', doc: { _id: 'r6' } },
      ]});

      sinon.stub(db, 'get').returns({ changes: sinon.stub().resolves({ results: [] }) });

      return service.__get__('purgeUnallocatedRecords')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(2);
        chai.expect(purgeFn.callCount).to.equal(12);
        chai.expect(purgeFn.args[0]).to.deep.equal([{ roles: roles['a'] }, {}, [{ _id: 'r1', form: 'a' }], []]);
        chai.expect(purgeFn.args[1]).to.deep.equal([{ roles: roles['b'] }, {}, [{ _id: 'r1', form: 'a' }], []]);
        chai.expect(purgeFn.args[2]).to.deep.equal([{ roles: roles['a'] }, {}, [{ _id: 'r2', form: 'a' }], []]);
        chai.expect(purgeFn.args[3]).to.deep.equal([{ roles: roles['b'] }, {}, [{ _id: 'r2', form: 'a' }], []]);
        chai.expect(purgeFn.args[4]).to.deep.equal([{ roles: roles['a'] }, {}, [], [{ _id: 'r3' }]]);
        chai.expect(purgeFn.args[5]).to.deep.equal([{ roles: roles['b'] }, {}, [], [{ _id: 'r3' }]]);
        chai.expect(purgeFn.args[6]).to.deep.equal([{ roles: roles['a'] }, {}, [{ _id: 'r4', form: 'a' }], []]);
        chai.expect(purgeFn.args[8]).to.deep.equal([{ roles: roles['a'] }, {}, [], [{ _id: 'r5' }]]);
        chai.expect(purgeFn.args[10]).to.deep.equal([{ roles: roles['a'] }, {}, [{ _id: 'r6', form: 'a' }], []]);
      });
    });

    it('should save new purges and remove old purges', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'r1', doc: { _id: 'r1', form: 'a' } },
        { id: 'r2', doc: { _id: 'r2', form: 'a' } },
        { id: 'r3', doc: { _id: 'r3' } },
        { id: 'r4', doc: { _id: 'r4', form: 'a' } },
        { id: 'r5', doc: { _id: 'r5' } },
        { id: 'r6', doc: { _id: 'r6', form: 'a' } },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'r6', doc: { _id: 'r6' } },
      ]});

      const dbA = { changes: sinon.stub(), bulkDocs: sinon.stub() };
      const dbB = { changes: sinon.stub(), bulkDocs: sinon.stub() };
      sinon.stub(db, 'get')
        .onCall(0).returns(dbA)
        .onCall(1).returns(dbB);

      dbA.changes.resolves({ results: [
        { id: 'purged:r1', changes: [{ rev: 'r1-rev' }] },
        { id: 'purged:r2', changes: [{ rev: 'r2-rev' }] },
        { id: 'purged:r5', changes: [{ rev: 'r5-rev' }], deleted: true },
        { id: 'purged:r6', changes: [{ rev: 'r6-rev' }], deleted: true },
      ]});

      dbB.changes.resolves({ results: [
        { id: 'purged:r2', changes: [{ rev: 'r2-rev' }] },
        { id: 'purged:r4', changes: [{ rev: 'r4-rev' }] },
        { id: 'purged:r5', changes: [{ rev: 'r5-rev' }], deleted: true },
        { id: 'purged:r6', changes: [{ rev: 'r6-rev' }], deleted: true },
      ]});

      purgeFn.withArgs({ roles: roles['a'] }, {}, [{ _id: 'r2', form: 'a' }], []).returns(['r2']);
      purgeFn.withArgs({ roles: roles['a'] }, {}, [], [{ _id: 'r3' }]).returns(['r3']);
      purgeFn.withArgs({ roles: roles['a'] }, {}, [], [{ _id: 'r5' }]).returns(['r5']);

      purgeFn.withArgs({ roles: roles['b'] }, {}, [], [{ _id: 'r3' }]).returns(['r3']);
      purgeFn.withArgs({ roles: roles['b'] }, {}, [{ _id: 'r4', form: 'a' }], []).returns(['r4']);
      purgeFn.withArgs({ roles: roles['b'] }, {}, [{ _id: 'r6', form: 'a' }], []).returns(['r6']);

      return service.__get__('purgeUnallocatedRecords')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(2);
        chai.expect(purgeFn.callCount).to.equal(12);
        chai.expect(dbA.bulkDocs.callCount).to.equal(1);
        chai.expect(dbA.bulkDocs.args[0]).to.deep.equal([{ docs: [
          { _id: 'purged:r1', _rev: 'r1-rev', _deleted: true },
          { _id: 'purged:r3' },
          { _id: 'purged:r5' },
        ]}]);
        chai.expect(dbB.bulkDocs.callCount).to.equal(1);
        chai.expect(dbB.bulkDocs.args[0]).to.deep.equal([{ docs: [
          { _id: 'purged:r2', _rev: 'r2-rev', _deleted: true },
          { _id: 'purged:r3' },
          { _id: 'purged:r6' },
        ]}]);
      });
    });

    it('should not allow purging of random docs', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'r1', doc: { _id: 'r1', form: 'a' } },
        { id: 'r2', doc: { _id: 'r2', form: 'a' } },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'r2', doc: { _id: 'r2', form: 'a' } },
      ]});

      const dbA = { changes: sinon.stub(), bulkDocs: sinon.stub() };
      const dbB = { changes: sinon.stub(), bulkDocs: sinon.stub() };
      sinon.stub(db, 'get')
        .onCall(0).returns(dbA)
        .onCall(1).returns(dbB);

      dbA.changes.resolves({ results: [
        { id: 'purged:r1', changes: [{ rev: 'r1-rev' }] },
      ]});

      dbB.changes.resolves({ results: []});

      purgeFn.withArgs({ roles: roles['a'] }, {}, [{ _id: 'r1', form: 'a' }], []).returns(['r1', 'r4', 'random']);
      purgeFn.withArgs({ roles: roles['a'] }, {}, [{ _id: 'r2', form: 'a' }], []).returns(['r3', 'r4', 'r2']);

      purgeFn.withArgs({ roles: roles['b'] }, {}, [{ _id: 'r1', form: 'a' }], []).returns(['random', '10', '11']);
      purgeFn.withArgs({ roles: roles['b'] }, {}, [{ _id: 'r2', form: 'a' }], []).returns(['oops', 'fifty', '22']);

      return service.__get__('purgeUnallocatedRecords')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(2);
        chai.expect(purgeFn.callCount).to.equal(4);
        chai.expect(dbA.bulkDocs.callCount).to.equal(1);
        chai.expect(dbA.bulkDocs.args[0]).to.deep.equal([{ docs: [ { _id: 'purged:r2' }]}]);
        chai.expect(dbB.bulkDocs.callCount).to.equal(0);
      });
    });

    it('should handle random results from purgefn', () => {
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'r1', doc: { _id: 'r1', form: 'a' } },
        { id: 'r2', doc: { _id: 'r2', form: 'a' } },
        { id: 'r3', doc: { _id: 'r3', form: 'a' } },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'r3', doc: { _id: 'r3', form: 'a' } },
      ]});

      const dbA = { changes: sinon.stub(), bulkDocs: sinon.stub() };
      const dbB = { changes: sinon.stub(), bulkDocs: sinon.stub() };
      sinon.stub(db, 'get')
        .onCall(0).returns(dbA)
        .onCall(1).returns(dbB);

      dbA.changes.resolves({ results: [
        { id: 'purged:r1', changes: [{ rev: 'r1-rev' }] },
      ]});

      dbB.changes.resolves({ results: []});

      purgeFn.withArgs({ roles: roles['a'] }, {}, [{ _id: 'r1', form: 'a' }], []).returns('rnd');
      purgeFn.withArgs({ roles: roles['a'] }, {}, [{ _id: 'r2', form: 'a' }], []).returns({});
      purgeFn.withArgs({ roles: roles['a'] }, {}, [{ _id: 'r3', form: 'a' }], []).returns(22);

      purgeFn.withArgs({ roles: roles['b'] }, {}, [{ _id: 'r1', form: 'a' }], []).returns(false);
      purgeFn.withArgs({ roles: roles['b'] }, {}, [{ _id: 'r2', form: 'a' }], []).returns(null);
      purgeFn.withArgs({ roles: roles['b'] }, {}, [{ _id: 'r3', form: 'a' }], []).returns([]);

      return service.__get__('purgeUnallocatedRecords')(roles, purgeFn).then(() => {
        chai.expect(request.get.callCount).to.equal(2);
        chai.expect(purgeFn.callCount).to.equal(6);
        chai.expect(dbA.bulkDocs.callCount).to.equal(1);
        chai.expect(dbA.bulkDocs.args[0]).to.deep.equal([{ docs: [
          { _id: 'purged:r1', _rev: 'r1-rev', _deleted: true }
        ]}]);
        chai.expect(dbB.bulkDocs.callCount).to.equal(0);
      });
    });

    it('should throw docs_by_replication_key errors ', () => {
      sinon.stub(request, 'get').rejects({ some: 'err' });

      return service.__get__('purgeUnallocatedRecords')(roles, purgeFn).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(err).to.deep.equal({ some: 'err' });
      });
    });

    it('should throw purgedb changes errors', () => {
      sinon.stub(request, 'get').resolves({ rows: [{ id: 'first', doc: { _id: 'first' } }]});
      const purgeDbChanges = sinon.stub().rejects({ some: 'err' });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      return service.__get__('purgeUnallocatedRecords')(roles, purgeFn).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(err).to.deep.equal({ some: 'err' });
      });
    });

    it('should throw purgefn errors', () => {
      sinon.stub(request, 'get').resolves({ rows: [{ id: 'first', doc: { _id: 'first' } }]});
      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });
      purgeFn.throws(new Error('error'));

      return service.__get__('purgeUnallocatedRecords')(roles, purgeFn).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(purgeDbChanges.callCount).to.equal(2);
        chai.expect(err.message).to.deep.equal('error');
      });
    });

    it('should throw purgedb _bulk_docs errors', () => {
      sinon.stub(request, 'get').resolves({ rows: [{ id: 'first', doc: { _id: 'first' }}]});
      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub().rejects({ some: 'err' }) });
      purgeFn.returns(['first']);

      return service.__get__('purgeUnallocatedRecords')(roles, purgeFn).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(purgeDbChanges.callCount).to.equal(2);
        chai.expect(purgeFn.callCount).to.equal(2);
        chai.expect(err).to.deep.equal({ some: 'err' });
      });
    });
  });

  describe('purgeTasks', () => {
    let roles;

    const getDaysAgo = (days) => moment().subtract(days, 'days').format('YYYY-MM-DD');

    beforeEach(() => {
      roles = { 'a': [1, 2, 3], 'b': [4, 5, 6] };
      db.couchUrl = 'http://a:p@localhost:6500/medic';
    });

    it('should request first batch', () => {
      sinon.stub(request, 'get').resolves({ rows:[] });
      clock = sinon.useFakeTimers(moment('2020-03-01').valueOf());

      return service.__get__('purgeTasks')(roles).then(() => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(request.get.args[0]).to.deep.equal([
          {
            url: 'http://a:p@localhost:6500/medic/_design/medic/_view/tasks_in_terminal_state',
            qs: {
              limit: 20000,
              end_key: JSON.stringify(getDaysAgo(60)),
              start_key: JSON.stringify(''),
              startkey_docid: '',
            },
            json: true
          }
        ]);
      });
    });

    it('should stop after no longer getting results', () => {
      clock = sinon.useFakeTimers(moment('2020-01-23').valueOf());

      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'task1', key: getDaysAgo(120) },
        { id: 'task2', key: getDaysAgo(100) },
        { id: 'task3', key: getDaysAgo(98) },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'task3', key: getDaysAgo(98) },
        { id: 'task4', key: getDaysAgo(78) },
        { id: 'task5', key: getDaysAgo(65) },
      ]});

      request.get.onCall(2).resolves({ rows: [
        { id: 'task5', key: getDaysAgo(65) },
      ]});

      sinon.stub(db, 'get').returns({changes: sinon.stub().resolves({ results: [] }), bulkDocs: sinon.stub() });

      return service.__get__('purgeTasks')(roles).then(() => {
        chai.expect(request.get.callCount).to.equal(3);
        chai.expect(request.get.args[0]).to.deep.equal([
          {
            url: 'http://a:p@localhost:6500/medic/_design/medic/_view/tasks_in_terminal_state',
            qs: {
              limit: 20000,
              end_key: JSON.stringify(getDaysAgo(60)),
              start_key: JSON.stringify(''),
              startkey_docid: '',
            },
            json: true,
          }]);

        chai.expect(request.get.args[1]).to.deep.equal([
          {
            url: 'http://a:p@localhost:6500/medic/_design/medic/_view/tasks_in_terminal_state',
            qs: {
              limit: 20000,
              end_key: JSON.stringify(getDaysAgo(60)),
              start_key: JSON.stringify(getDaysAgo(98)),
              startkey_docid: 'task3',
            },
            json: true,
          }]);

        chai.expect(request.get.args[2]).to.deep.equal([
          {
            url: 'http://a:p@localhost:6500/medic/_design/medic/_view/tasks_in_terminal_state',
            qs: {
              limit: 20000,
              end_key: JSON.stringify(getDaysAgo(60)),
              start_key: JSON.stringify(getDaysAgo(65)),
              startkey_docid: 'task5',
            },
            json: true,
          }]);
      });
    });

    it('should save new purges', () => {
      clock = sinon.useFakeTimers(moment('2020-01-23').valueOf());

      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 't1', key: getDaysAgo(120) },
        { id: 't2', key: getDaysAgo(115) },
        { id: 't3', key: getDaysAgo(110) },
        { id: 't4', key: getDaysAgo(90) },
        { id: 't5', key: getDaysAgo(80) },
        { id: 't6', key: getDaysAgo(70) },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 't6', key: getDaysAgo(70) },
      ]});

      const dbA = { changes: sinon.stub(), bulkDocs: sinon.stub() };
      const dbB = { changes: sinon.stub(), bulkDocs: sinon.stub() };
      sinon.stub(db, 'get')
        .onCall(0).returns(dbA)
        .onCall(1).returns(dbB);

      dbA.changes.resolves({ results: [] });

      dbB.changes.resolves({ results: [
        { id: 'purged:t2', changes: [{ rev: 't2-rev' }] },
        { id: 'purged:t5', changes: [{ rev: 't5-rev' }] },
      ]});

      return service.__get__('purgeTasks')(roles).then(() => {
        chai.expect(request.get.callCount).to.equal(2);
        chai.expect(dbA.bulkDocs.callCount).to.equal(1);
        chai.expect(dbA.bulkDocs.args[0]).to.deep.equal([{ docs: [
          { _id: 'purged:t1' },
          { _id: 'purged:t2' },
          { _id: 'purged:t3' },
          { _id: 'purged:t4' },
          { _id: 'purged:t5' },
          { _id: 'purged:t6' },
        ]}]);
        chai.expect(dbB.bulkDocs.callCount).to.equal(1);
        chai.expect(dbB.bulkDocs.args[0]).to.deep.equal([{ docs: [
          { _id: 'purged:t1' },
          { _id: 'purged:t3' },
          { _id: 'purged:t4' },
          { _id: 'purged:t6' },
        ]}]);
      });
    });

    it('should throw view errors ', () => {
      sinon.stub(request, 'get').rejects({ some: 'err' });

      return service.__get__('purgeTasks')(roles).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(err).to.deep.equal({ some: 'err' });
      });
    });

    it('should throw purgedb changes errors', () => {
      sinon.stub(request, 'get').resolves({ rows: [{ id: 'first', value: { endDate: 100 } }]});
      const purgeDbChanges = sinon.stub().rejects({ some: 'err' });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      return service.__get__('purgeTasks')(roles).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(err).to.deep.equal({ some: 'err' });
      });
    });

    it('should throw purgedb _bulk_docs errors', () => {
      sinon.stub(request, 'get').resolves({ rows: [{ id: 'first', value: { endDate: 100 }}]});
      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub().rejects({ some: 'err' }) });

      return service.__get__('purgeTasks')(roles).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(purgeDbChanges.callCount).to.equal(2);
        chai.expect(err).to.deep.equal({ some: 'err' });
      });
    });
  });

  describe('purgeTargets', () => {
    let roles;

    beforeEach(() => {
      roles = { 'a': [1, 2, 3], 'b': [4, 5, 6] };
      db.couchUrl = 'http://a:p@localhost:6500/medic';
    });

    it('should request first batch, preserving last 6 months of target docs', () => {
      sinon.stub(request, 'get').resolves({ rows:[] });
      const now = moment('2020-03-23').valueOf();
      sinon.useFakeTimers(now);
      return service.__get__('purgeTargets')(roles).then(() => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(request.get.args[0]).to.deep.equal([
          {
            url: 'http://a:p@localhost:6500/medic/_all_docs',
            qs: {
              limit: 20000,
              start_key: JSON.stringify('target~'),
              end_key: JSON.stringify('target~2019-09~'),
            },
            json: true
          }
        ]);
      });
    });

    it('should stop after no longer getting results', () => {
      const now = moment('2020-02-23').valueOf();
      clock = sinon.useFakeTimers(now);
      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'target~2019~05~one' },
        { id: 'target~2019~05~two' },
        { id: 'target~2019~05~three' },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'target~2019~06~three' },
        { id: 'target~2019~06~one' },
        { id: 'target~2019~06~two' },
      ]});

      request.get.onCall(2).resolves({ rows: [
        { id: 'target~2019~06~two' },
      ]});

      const dbA = { changes: sinon.stub(), bulkDocs: sinon.stub() };
      dbA.changes.resolves({ results: [] });
      dbA.bulkDocs.resolves([]);
      sinon.stub(db, 'get').returns(dbA);

      return service.__get__('purgeTargets')(roles).then(() => {
        chai.expect(request.get.callCount).to.equal(3);
        chai.expect(request.get.args[0]).to.deep.equal([
          {
            url: 'http://a:p@localhost:6500/medic/_all_docs',
            qs: {
              limit: 20000,
              start_key: JSON.stringify('target~'),
              end_key: JSON.stringify('target~2019-08~'),
            },
            json: true,
          }]);

        chai.expect(request.get.args[1]).to.deep.equal([
          {
            url: 'http://a:p@localhost:6500/medic/_all_docs',
            qs: {
              limit: 20000,
              start_key: JSON.stringify('target~2019~05~three'),
              end_key: JSON.stringify('target~2019-08~'),
            },
            json: true,
          }]);

        chai.expect(request.get.args[2]).to.deep.equal([
          {
            url: 'http://a:p@localhost:6500/medic/_all_docs',
            qs: {
              limit: 20000,
              start_key: JSON.stringify('target~2019~06~two'),
              end_key: JSON.stringify('target~2019-08~'),
            },
            json: true,
          }]);
      });
    });

    it('should save new purges', () => {
      const now = moment('2020-01-14').valueOf();
      clock = sinon.useFakeTimers(now);

      sinon.stub(request, 'get');
      request.get.onCall(0).resolves({ rows: [
        { id: 'target~2019~03~user1' },
        { id: 'target~2019~03~user2' },
        { id: 'target~2019~03~user3' },
        { id: 'target~2019~04~user1' },
        { id: 'target~2019~04~user2' },
        { id: 'target~2019~04~user3' },
        { id: 'target~2019~05~user1' },
        { id: 'target~2019~05~user2' },
      ]});

      request.get.onCall(1).resolves({ rows: [
        { id: 'target~2019~05~user2' },
      ]});

      const dbA = { changes: sinon.stub(), bulkDocs: sinon.stub() };
      const dbB = { changes: sinon.stub(), bulkDocs: sinon.stub() };
      sinon.stub(db, 'get')
        .onCall(0).returns(dbA)
        .onCall(1).returns(dbB);

      dbA.changes.resolves({ results: [] });

      dbB.changes.resolves({ results: [
        { id: 'purged:target~2019~03~user1', changes: [{ rev: 't2-rev' }] },
        { id: 'purged:target~2019~03~user2', changes: [{ rev: 't5-rev' }] },
        { id: 'purged:target~2019~03~user3', changes: [{ rev: 't5-rev' }] },
      ]});

      return service.__get__('purgeTargets')(roles).then(() => {
        chai.expect(request.get.callCount).to.equal(2);
        chai.expect(dbA.bulkDocs.callCount).to.equal(1);
        chai.expect(dbA.bulkDocs.args[0]).to.deep.equal([{ docs: [
          { _id: 'purged:target~2019~03~user1' },
          { _id: 'purged:target~2019~03~user2' },
          { _id: 'purged:target~2019~03~user3' },
          { _id: 'purged:target~2019~04~user1' },
          { _id: 'purged:target~2019~04~user2' },
          { _id: 'purged:target~2019~04~user3' },
          { _id: 'purged:target~2019~05~user1' },
          { _id: 'purged:target~2019~05~user2' },
        ]}]);
        chai.expect(dbB.bulkDocs.callCount).to.equal(1);
        chai.expect(dbB.bulkDocs.args[0]).to.deep.equal([{ docs: [
          { _id: 'purged:target~2019~04~user1' },
          { _id: 'purged:target~2019~04~user2' },
          { _id: 'purged:target~2019~04~user3' },
          { _id: 'purged:target~2019~05~user1' },
          { _id: 'purged:target~2019~05~user2' },
        ]}]);
      });
    });

    it('should throw allDocs errors ', () => {
      sinon.stub(request, 'get').rejects({ some: 'err' });

      return service.__get__('purgeTargets')(roles).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(err).to.deep.equal({ some: 'err' });
      });
    });

    it('should throw purgedb changes errors', () => {
      sinon.stub(request, 'get').resolves({ rows: [{ id: 'target~2019-02~fdsdfsdfs' }]});
      const purgeDbChanges = sinon.stub().rejects({ some: 'err' });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub() });

      return service.__get__('purgeTargets')(roles).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(err).to.deep.equal({ some: 'err' });
      });
    });

    it('should throw purgedb _bulk_docs errors', () => {
      sinon.stub(request, 'get').resolves({ rows: [{ id: 'target~2019-02~fdsdfsdfs' }]});
      const purgeDbChanges = sinon.stub().resolves({ results: [] });
      sinon.stub(db, 'get').returns({ changes: purgeDbChanges, bulkDocs: sinon.stub().rejects({ some: 'err' }) });

      return service.__get__('purgeTargets')(roles).catch(err => {
        chai.expect(request.get.callCount).to.equal(1);
        chai.expect(purgeDbChanges.callCount).to.equal(2);
        chai.expect(err).to.deep.equal({ some: 'err' });
      });
    });
  });

  describe('purge', () => {
    let getPurgeFn;
    let getRoles;
    let initPurgeDbs;
    let closePurgeDbs;
    let purgeContacts;
    let purgeUnallocatedRecords;
    let purgeTasks;
    let purgeTargets;
    let purgeFn;

    beforeEach(() => {
      getPurgeFn = sinon.stub();
      getRoles = sinon.stub();
      initPurgeDbs = sinon.stub();
      closePurgeDbs = sinon.stub();
      purgeContacts = sinon.stub();
      purgeUnallocatedRecords = sinon.stub();
      purgeTasks = sinon.stub();
      purgeTargets = sinon.stub();
      purgeFn = sinon.stub();
    });

    it('should not purge if no purge function is configured', () => {
      service.__set__('getPurgeFn', getPurgeFn);
      service.__set__('getRoles', getRoles);
      return service.__get__('purge')().then(() => {
        chai.expect(getPurgeFn.callCount).to.equal(1);
        chai.expect(getRoles.callCount).to.equal(0);
      });
    });

    it('should not purge when no roles', () => {
      getPurgeFn.returns(purgeFn);
      getRoles.resolves({});
      service.__set__('getPurgeFn', getPurgeFn);
      service.__set__('getRoles', getRoles);
      service.__set__('initPurgeDbs', initPurgeDbs);
      sinon.stub(db.sentinel, 'put').resolves();

      return service.__get__('purge')().then(() => {
        chai.expect(getPurgeFn.callCount).to.equal(1);
        chai.expect(getRoles.callCount).to.equal(1);
        chai.expect(initPurgeDbs.callCount).to.equal(0);
      });
    });

    it('should not purge if purge is already running', () => {
      const roles = { 'a': [1, 2, 3], 'b': [1, 2, 4] };
      getPurgeFn.returns(purgeFn);
      getRoles.resolves(roles);
      initPurgeDbs.resolves();
      purgeContacts.resolves();
      purgeUnallocatedRecords.resolves();
      sinon.stub(db.sentinel, 'put').resolves();

      service.__set__('getPurgeFn', getPurgeFn);
      service.__set__('getRoles', getRoles);
      service.__set__('initPurgeDbs', initPurgeDbs);
      service.__set__('purgeContacts', purgeContacts);
      service.__set__('purgeUnallocatedRecords', purgeUnallocatedRecords);
      service.__set__('purgeTasks', purgeTasks);
      service.__set__('purgeTargets', purgeTargets);
      service.__set__('closePurgeDbs', closePurgeDbs);

      const promises = [];
      promises.push(service.__get__('purge')());
      promises.push(service.__get__('purge')());
      promises.push(service.__get__('purge')());
      promises.push(service.__get__('purge')());

      return Promise.all(promises).then(() => {
        chai.expect(getPurgeFn.callCount).to.equal(1);
        chai.expect(getRoles.callCount).to.equal(1);
        chai.expect(initPurgeDbs.callCount).to.equal(1);
        chai.expect(purgeContacts.callCount).to.equal(1);
        chai.expect(purgeContacts.args[0]).to.deep.equal([ roles, purgeFn ]);
        chai.expect(purgeUnallocatedRecords.callCount).to.equal(1);
        chai.expect(purgeUnallocatedRecords.args[0]).to.deep.equal([ roles, purgeFn ]);
        chai.expect(purgeTasks.callCount).to.equal(1);
        chai.expect(purgeTasks.args[0]).to.deep.equal([ roles ]);
        chai.expect(purgeTargets.callCount).to.equal(1);
        chai.expect(purgeTargets.args[0]).to.deep.equal([ roles ]);
        chai.expect(db.sentinel.put.callCount).to.equal(1);
        chai.expect(closePurgeDbs.callCount).to.equal(1);
      });
    });

    it('should initialize dbs, run per contact, unallocated, tasks and targets purges', () => {
      const now = moment('2020-01-01');
      clock = sinon.useFakeTimers(now.valueOf());
      const roles = { 'a': [1, 2, 3], 'b': [1, 2, 4] };
      getPurgeFn.returns(purgeFn);
      getRoles.resolves(roles);
      initPurgeDbs.resolves();
      purgeContacts.callsFake(() => {
        service.__set__('skippedContacts', ['a', 'b', 'c']);
        return Promise.resolve();
      });
      purgeUnallocatedRecords.resolves();
      sinon.stub(db.sentinel, 'put').resolves();
      sinon.stub(performance, 'now');
      performance.now.onCall(0).returns(0);
      performance.now.onCall(1).returns(65000);

      service.__set__('getPurgeFn', getPurgeFn);
      service.__set__('getRoles', getRoles);
      service.__set__('initPurgeDbs', initPurgeDbs);
      service.__set__('purgeContacts', purgeContacts);
      service.__set__('purgeUnallocatedRecords', purgeUnallocatedRecords);
      service.__set__('purgeTasks', purgeTasks);
      service.__set__('purgeTargets', purgeTargets);
      service.__set__('closePurgeDbs', closePurgeDbs);

      return service.__get__('purge')().then(() => {
        chai.expect(getPurgeFn.callCount).to.equal(1);
        chai.expect(getRoles.callCount).to.equal(1);
        chai.expect(initPurgeDbs.callCount).to.equal(1);
        chai.expect(purgeContacts.callCount).to.equal(1);
        chai.expect(purgeContacts.args[0]).to.deep.equal([ roles, purgeFn ]);
        chai.expect(purgeUnallocatedRecords.callCount).to.equal(1);
        chai.expect(purgeUnallocatedRecords.args[0]).to.deep.equal([ roles, purgeFn ]);
        chai.expect(purgeTasks.callCount).to.equal(1);
        chai.expect(purgeTasks.args[0]).to.deep.equal([ roles ]);
        chai.expect(purgeTargets.callCount).to.equal(1);
        chai.expect(purgeTargets.args[0]).to.deep.equal([ roles ]);
        chai.expect(db.sentinel.put.callCount).to.equal(1);
        chai.expect(closePurgeDbs.callCount).to.equal(1);

        chai.expect(db.sentinel.put.callCount).to.equal(1);
        chai.expect(db.sentinel.put.args[0][0]).to.deep.equal({
          _id: `purgelog:${now.valueOf()}`,
          date: now.toISOString(),
          duration: 65000,
          error: undefined,
          roles: roles,
          skipped_contacts: ['a', 'b', 'c'],
        });
      });
    });

    it('should catch any errors thrown when getting roles', () => {
      getPurgeFn.returns(purgeFn);
      getRoles.rejects({ message: 'booom' });

      service.__set__('getPurgeFn', getPurgeFn);
      service.__set__('getRoles', getRoles);
      service.__set__('initPurgeDbs', initPurgeDbs);
      service.__set__('purgeContacts', purgeContacts);
      service.__set__('purgeUnallocatedRecords', purgeUnallocatedRecords);
      service.__set__('closePurgeDbs', closePurgeDbs);
      sinon.stub(db.sentinel, 'put').resolves();

      return service.__get__('purge')().then(() => {
        chai.expect(getPurgeFn.callCount).to.equal(1);
        chai.expect(getRoles.callCount).to.equal(1);
        chai.expect(initPurgeDbs.callCount).to.equal(0);
        chai.expect(purgeContacts.callCount).to.equal(0);
        chai.expect(purgeUnallocatedRecords.callCount).to.equal(0);
        chai.expect(closePurgeDbs.callCount).to.equal(1);

        chai.expect(db.sentinel.put.callCount).to.equal(1);
        const purgelog = db.sentinel.put.args[0][0];
        chai.expect(purgelog._id).to.contain('purgelog:error');
        chai.expect(purgelog).to.deep.include({
          skipped_contacts: [],
          error: 'booom',
        });
      });
    });

    it('should catch any errors thrown when initing dbs', () => {
      const now = moment('2019-09-20');
      clock = sinon.useFakeTimers(now.valueOf());
      const roles = { 'a': [1, 2, 3], 'b': [1, 2, 4] };
      getPurgeFn.returns(purgeFn);
      getRoles.resolves(roles);
      initPurgeDbs.rejects({ message: 'something' });
      sinon.stub(performance, 'now');
      performance.now.onCall(0).returns(1000);
      performance.now.onCall(1).returns(2000);

      service.__set__('getPurgeFn', getPurgeFn);
      service.__set__('getRoles', getRoles);
      service.__set__('initPurgeDbs', initPurgeDbs);
      service.__set__('purgeContacts', purgeContacts);
      service.__set__('purgeUnallocatedRecords', purgeUnallocatedRecords);
      service.__set__('closePurgeDbs', closePurgeDbs);
      sinon.stub(db.sentinel, 'put').resolves();

      return service.__get__('purge')().then(() => {
        chai.expect(getPurgeFn.callCount).to.equal(1);
        chai.expect(getRoles.callCount).to.equal(1);
        chai.expect(initPurgeDbs.callCount).to.equal(1);
        chai.expect(purgeContacts.callCount).to.equal(0);
        chai.expect(purgeUnallocatedRecords.callCount).to.equal(0);
        chai.expect(closePurgeDbs.callCount).to.equal(1);

        chai.expect(db.sentinel.put.callCount).to.equal(1);
        chai.expect(db.sentinel.put.args[0][0]).to.deep.equal({
          _id: `purgelog:error:${now.valueOf()}`,
          skipped_contacts: [],
          error: 'something',
          date: now.toISOString(),
          roles: roles,
          duration: 1000,
        });
      });
    });

    it('should catch any errors thrown when doing batched contacts purge', () => {
      const roles = { 'a': [1, 2, 3], 'b': [1, 2, 4] };
      getPurgeFn.returns(purgeFn);
      getRoles.resolves(roles);
      initPurgeDbs.resolves();
      purgeContacts.rejects({ no: 'message' });
      sinon.stub(db.sentinel, 'put').resolves();

      service.__set__('getPurgeFn', getPurgeFn);
      service.__set__('getRoles', getRoles);
      service.__set__('initPurgeDbs', initPurgeDbs);
      service.__set__('purgeContacts', purgeContacts);
      service.__set__('purgeUnallocatedRecords', purgeUnallocatedRecords);
      service.__set__('closePurgeDbs', closePurgeDbs);

      return service.__get__('purge')().then(() => {
        chai.expect(getPurgeFn.callCount).to.equal(1);
        chai.expect(getRoles.callCount).to.equal(1);
        chai.expect(initPurgeDbs.callCount).to.equal(1);
        chai.expect(purgeContacts.callCount).to.equal(1);
        chai.expect(purgeContacts.args[0]).to.deep.equal([ roles, purgeFn ]);
        chai.expect(purgeUnallocatedRecords.callCount).to.equal(0);
        chai.expect(closePurgeDbs.callCount).to.equal(1);

        chai.expect(db.sentinel.put.callCount).to.equal(1);
        const purgelog = db.sentinel.put.args[0][0];
        chai.expect(purgelog._id).to.contain('purgelog:error');
        chai.expect(purgelog).to.deep.include({
          skipped_contacts: [],
          error: undefined,
        });
      });
    });

    it('should catch any errors thrown when doing batched unallocated purge', () => {
      const roles = { 'a': [1, 2, 3], 'b': [1, 2, 4] };
      getPurgeFn.returns(purgeFn);
      getRoles.resolves(roles);
      initPurgeDbs.resolves();
      purgeContacts.resolves();
      purgeUnallocatedRecords.rejects({});
      service.__set__('closePurgeDbs', closePurgeDbs);
      sinon.stub(db.sentinel, 'put').resolves();

      service.__set__('getPurgeFn', getPurgeFn);
      service.__set__('getRoles', getRoles);
      service.__set__('initPurgeDbs', initPurgeDbs);
      service.__set__('purgeContacts', purgeContacts);
      service.__set__('purgeUnallocatedRecords', purgeUnallocatedRecords);

      return service.__get__('purge')().then(() => {
        chai.expect(getPurgeFn.callCount).to.equal(1);
        chai.expect(getRoles.callCount).to.equal(1);
        chai.expect(initPurgeDbs.callCount).to.equal(1);
        chai.expect(purgeContacts.callCount).to.equal(1);
        chai.expect(purgeContacts.args[0]).to.deep.equal([ roles, purgeFn ]);
        chai.expect(purgeUnallocatedRecords.callCount).to.equal(1);
        chai.expect(purgeUnallocatedRecords.args[0]).to.deep.equal([ roles, purgeFn ]);
        chai.expect(closePurgeDbs.callCount).to.equal(1);
        chai.expect(db.sentinel.put.callCount).to.equal(1);
      });
    });

    it('should catch any errors thrown when doing batched tasks purge', () => {
      const roles = { 'a': [1, 2, 3], 'b': [1, 2, 4] };
      getPurgeFn.returns(purgeFn);
      getRoles.resolves(roles);
      initPurgeDbs.resolves();
      purgeContacts.resolves();
      purgeUnallocatedRecords.resolves();
      purgeTasks.rejects({});
      service.__set__('closePurgeDbs', closePurgeDbs);
      sinon.stub(db.sentinel, 'put').resolves();

      service.__set__('getPurgeFn', getPurgeFn);
      service.__set__('getRoles', getRoles);
      service.__set__('initPurgeDbs', initPurgeDbs);
      service.__set__('purgeContacts', purgeContacts);
      service.__set__('purgeUnallocatedRecords', purgeUnallocatedRecords);
      service.__set__('purgeTasks', purgeTasks);

      return service.__get__('purge')().then(() => {
        chai.expect(getPurgeFn.callCount).to.equal(1);
        chai.expect(getRoles.callCount).to.equal(1);
        chai.expect(initPurgeDbs.callCount).to.equal(1);
        chai.expect(purgeContacts.callCount).to.equal(1);
        chai.expect(purgeContacts.args[0]).to.deep.equal([ roles, purgeFn ]);
        chai.expect(purgeUnallocatedRecords.callCount).to.equal(1);
        chai.expect(purgeUnallocatedRecords.args[0]).to.deep.equal([ roles, purgeFn ]);
        chai.expect(purgeTasks.callCount).to.equal(1);
        chai.expect(purgeTasks.args[0]).to.deep.equal([ roles ]);
        chai.expect(closePurgeDbs.callCount).to.equal(1);
        chai.expect(db.sentinel.put.callCount).to.equal(1);
      });
    });
  });
});
