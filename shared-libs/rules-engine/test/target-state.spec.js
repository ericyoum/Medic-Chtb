const { expect } = require('chai');
const sinon = require('sinon');

const targetState = require('../src/target-state');

const mockTargetDefinition = () => ({ id: 'target' });
const mockSettingsDoc = (items = [mockTargetDefinition()]) => ({ tasks: { targets: { items } } });
const mockEmission = assigned => Object.assign({ _id: '123', type: 'target', pass: true, contact: { _id: 'a', reported_date: 1 } }, assigned);

describe('target-state', () => {
  afterEach(() => sinon.restore());

  it('empty settings doc yields empty state', () => {
    const state = targetState.createEmptyState({});
    expect(state).to.deep.eq({});
  });

  it('an empty state', () => {
    const state = targetState.createEmptyState(mockSettingsDoc());
    expect(state).to.deep.eq({
      target: {
        emissions: {},
        id: 'target',
        isContextual: undefined,
      },
    });
  });

  it('filter targets by context', () => {
    const noContext = { id: 'undef' };
    const match = { id: 'match', isContextual: () => true };
    const noMatch = { id: 'no', isContextual: () => false };

    const settingsDoc = mockSettingsDoc([noContext, match, noMatch]);
    const state = targetState.createEmptyState(settingsDoc, { prop: 'hi' });
    expect(state).excludingEvery(['emissions', 'isContextual']).to.deep.eq({
      match,
      undef: noContext,
    });
  });

  it('add and update a single emission', () => {
    let state = targetState.createEmptyState(mockSettingsDoc());
   
    targetState.storeTargetEmissions(state, ['a'], [mockEmission()]);
    expect(targetState.aggregateStoredTargetEmissions(state)).to.deep.eq([{
      id: 'target',
      value: { pass: 1, total: 1 },
    }]);

    const another = mockEmission({ pass: false });
    targetState.storeTargetEmissions(state, ['a'], [another]);
    expect(targetState.aggregateStoredTargetEmissions(state)).to.deep.eq([{
      id: 'target',
      value: { pass: 0, total: 1 },
    }]);
  });
 
  it('emission for unknown target id is ignored', () => {
    let state = targetState.createEmptyState(mockSettingsDoc());
    targetState.storeTargetEmissions(state, ['a'], [mockEmission({ type: 'foo' })]);
    expect(state).to.deep.eq(targetState.createEmptyState(mockSettingsDoc()));
  });

  it('emission for filtered target id is ignored', () => {
    const notContextual = { id: 'target', isContextual: () => false };
    const state = targetState.createEmptyState(mockSettingsDoc([notContextual]));
    targetState.storeTargetEmissions(state, ['a'], [mockEmission({ type: 'foo' })]);
    expect(state).to.deep.eq({});
  });

  it('emission without contact is ignored', () => {
    let state = targetState.createEmptyState(mockSettingsDoc());
    targetState.storeTargetEmissions(state, ['a'], [mockEmission({ contact: undefined })]);
    expect(targetState.aggregateStoredTargetEmissions(state)).to.deep.eq([{
      id: 'target',
      value: { pass: 0, total: 0 },
    }]);
  });

  it('deleted emission is ignored', () => {
    let state = targetState.createEmptyState(mockSettingsDoc());
    targetState.storeTargetEmissions(state, ['a'], [mockEmission({ deleted: true })]);
    expect(targetState.aggregateStoredTargetEmissions(state)).to.deep.eq([{
      id: 'target',
      value: { pass: 0, total: 0 },
    }]);
  });

  it('add and remove an emission', () => {
    let state = targetState.createEmptyState(mockSettingsDoc());
    targetState.storeTargetEmissions(state, ['a'], [mockEmission()]);
    targetState.storeTargetEmissions(state, ['a'], []);
    expect(targetState.aggregateStoredTargetEmissions(state)).to.deep.eq([{
      id: 'target',
      value: { pass: 0, total: 0 },
    }]);
  });

  it('two contacts add emission and one removes (state change)', () => {
    let state = targetState.createEmptyState(mockSettingsDoc());
    targetState.storeTargetEmissions(state, ['a'], [mockEmission()]);
    targetState.storeTargetEmissions(state, ['b'], [mockEmission({ pass: false, contact: { _id: 'b', reported_date: 2 } })]);
   
    expect(targetState.aggregateStoredTargetEmissions(state)).to.deep.eq([{
      id: 'target',
      value: { pass: 0, total: 1 },
    }]);

    targetState.storeTargetEmissions(state, ['b'], []);
    expect(targetState.aggregateStoredTargetEmissions(state)).to.deep.eq([{
      id: 'target',
      value: { pass: 1, total: 1 },
    }]);
  });

  it('three contacts add emission and two remove (no state change)', () => {
    let state = targetState.createEmptyState(mockSettingsDoc());
    targetState.storeTargetEmissions(state, ['a', 'b'], [mockEmission({ pass: false, contact: { _id: 'b', reported_date: 2 } }), mockEmission({ contact: { _id: 'a', reported_date: 1 } })]);
    targetState.storeTargetEmissions(state, ['c'], [mockEmission({ contact: { _id: 'c', reported_date: 3 } })]);
   
    expect(targetState.aggregateStoredTargetEmissions(state)).to.deep.eq([{
      id: 'target',
      value: { pass: 1, total: 1 },
    }]);

    targetState.storeTargetEmissions(state, ['a', 'dne', 'b'], []);
    expect(targetState.aggregateStoredTargetEmissions(state)).to.deep.eq([{
      id: 'target',
      value: { pass: 1, total: 1 },
    }]);
  });

  it('two contacts add and remove emission', () => {
    const settingsDoc = mockSettingsDoc();
    settingsDoc.tasks.targets.items[0].type = 'percent';
   
    let state = targetState.createEmptyState(settingsDoc);
    targetState.storeTargetEmissions(state, [], [mockEmission({ pass: false }), mockEmission({ pass: true, _id: 'other' }), mockEmission({ pass: true, contact: { _id: 'b', reported_date: 2 } })]);
   
    expect(targetState.aggregateStoredTargetEmissions(state)).to.deep.eq([{
      id: 'target',
      type: 'percent',
      value: {
        pass: 2,
        total: 2,
        percent: 100,
      },
    }]);

    targetState.storeTargetEmissions(state, ['b', 'a'], []);
    expect(targetState.aggregateStoredTargetEmissions(state)).to.deep.eq([{
      id: 'target',
      type: 'percent',
      value: {
        pass: 0,
        total: 0,
        percent: 0,
      },
    }]);
  });

  it('instanceFilter isRelevant', () => {
    let state = targetState.createEmptyState(mockSettingsDoc());
    targetState.storeTargetEmissions(state, [], [
      mockEmission({ pass: false, date: 1000, }),
      mockEmission({ pass: true, date: 2000, _id: 'other' }),
      mockEmission({ pass: true, date: 3000, _id: 'another' })
    ]);
   
    expect(targetState.aggregateStoredTargetEmissions(state)).to.deep.eq([{
      id: 'target',
      value: { pass: 2, total: 3 },
    }]);

    const instanceFilter = instance => instance.date === 2000;
    expect(targetState.aggregateStoredTargetEmissions(state, instanceFilter)).to.deep.eq([{
      id: 'target',
      value: { pass: 1, total: 1 },
    }]);
  });
});

