const ZScoreForm = require('../../page-objects/forms/z-score.wdio.page');
const reportsPage = require('../../page-objects/reports/reports.wdio.page');
const loginPage = require('../../page-objects/login/login.wdio.page')
const constants = require('../../constants');

const userContactDoc = {
  _id: constants.USER_CONTACT_ID,
  name: 'Jack',
  date_of_birth: '',
  phone: '+64274444444',
  alternate_phone: '',
  notes: '',
  type: 'person',
  reported_date: 1478469976421,
  parent: {
    _id: 'some_parent'
  }
};



describe('Submit Z-Score form', () => {
  before(async () => {
    await ZScoreForm.configureForm(userContactDoc);
    await loginPage.cookieLogin();
  });

  //beforeEach(utils.resetBrowser);

  it('Autofills zscore fields with correct values', async () => {
    await ZScoreForm.load();

    await ZScoreForm.setPatient({ sex: 'female', height: 45, weight: 2, age: 0 });

    expect(await ZScoreForm.getHeightForAge()).to.equal('-2.226638023630504');
    expect(await ZScoreForm.getWeightForAge()).to.equal('-3.091160220994475');
    expect(await ZScoreForm.getWeightForHeight()).to.equal('-2.402439024390243');

    await ZScoreForm.setPatient({ sex: 'male', height: 45, weight: 2, age: 0 });

    expect(await ZScoreForm.getHeightForAge()).to.equal('-2.5800316957210767');
    expect(await ZScoreForm.getWeightForAge()).to.equal('-3.211081794195251');
    expect(await ZScoreForm.getWeightForHeight()).to.equal('-2.259036144578314');

    await ZScoreForm.setPatient({ sex: 'female', height: 45.2, weight: 5, age: 1 });

    expect(await ZScoreForm.getHeightForAge()).to.equal('-2.206434316353886');
    expect(await ZScoreForm.getWeightForAge()).to.equal('3.323129251700681');
    expect(await ZScoreForm.getWeightForHeight()).to.equal('4');

    await ZScoreForm.setPatient({ sex: 'male', height: 45.2, weight: 5, age: 1 });

    expect(await ZScoreForm.getHeightForAge()).to.equal('-2.5651715039577816');
    expect(await ZScoreForm.getWeightForAge()).to.equal('2.9789983844911148');
    expect(await ZScoreForm.getWeightForHeight()).to.equal('4');
  });

  it('saves z-score values', async () => {
    await ZScoreForm.load();

    await ZScoreForm.setPatient({ sex: 'female', height: 45.1, weight: 3, age: 2 });

    expect(await ZScoreForm.getHeightForAge()).to.equal('-2.346895074946466');
    expect(await ZScoreForm.getWeightForAge()).to.equal('-0.4708520179372194');
    expect(await ZScoreForm.getWeightForHeight()).to.equal('2.0387096774193547');

    await reportsPage.submitForm();

    expect(await ZScoreForm.fieldByIndex(1)).to.equal('45.1');
    expect(await ZScoreForm.fieldByIndex(2)).to.equal('3');
    expect(await ZScoreForm.fieldByIndex(3)).to.equal('female');
    expect(await ZScoreForm.fieldByIndex(4)).to.equal('2');
    expect(await ZScoreForm.fieldByIndex(5)).to.equal('2.0387096774193547');
    expect(await ZScoreForm.fieldByIndex(6)).to.equal('-0.4708520179372194');
    expect(await ZScoreForm.fieldByIndex(7)).to.equal('-2.346895074946466');
  });
});
