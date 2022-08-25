const utils = require('../../utils');
const userData = require('../../page-objects/forms/data/user.po.data');
const loginPage = require('../../page-objects/login/login.wdio.page');
const commonPage = require('../../page-objects/common/common.wdio.page');
const genericForm = require('../../page-objects/forms/generic-form.wdio.page');
const sentinelUtils = require('../sentinel/utils');
const contactsPage = require('../../page-objects/contacts/contacts.wdio.page');

describe('Offline user replace form', () => {
  const sync = async () => {
    await commonPage.openHamburgerMenu();
    await (await commonPage.syncButton()).click();
    await browser.waitUntil(async () => await commonPage.snackbarMessage() === 'All reports synced');
  };

  before(async () => {
    // TODO: use CHW user account, not admin
    await utils.seedTestData(userData.userContactDoc, userData.docs);
    await loginPage.cookieLogin();
    await commonPage.goToPeople(userData.userContactDoc._id);
  });

  it('Replace the current CHW with another one, offline', async () => {
    await browser.throttle('offline');

    // open replace user form
    const newActionButton = await $('.detail-actions .actions .dropdown-toggle .fa-plus');
    await newActionButton.click();
    const replaceUserActionButton = await $('li[id="form:replace_user"]');
    await replaceUserActionButton.waitForDisplayed();
    await replaceUserActionButton.click();

    // fill the first page
    const adminCodeField = await $('input[name="/replace_user/intro/admin_code"]');
    await adminCodeField.waitForDisplayed();
    await adminCodeField.setValue('000000');
    await genericForm.nextPage();

    // fill the second page and submit the form
    const fullNameField = await $('input[name="/replace_user/new_contact/name"]');
    await fullNameField.waitForDisplayed();
    await fullNameField.setValue('Replacement User');
    const sexField = await $('input[name="/replace_user/new_contact/sex"][value="male"]');
    await sexField.click();
    const dobField = await contactsPage.dateOfBirthField();
    await dobField.addValue('2000-01-15');
    await (await genericForm.submitButton()).click();

    // TODO: fill out a few forms and make sure they're reparented

    await browser.throttle('online');
    await sync();
    await sentinelUtils.waitForSentinel();
    await sync();

    expect(await browser.getUrl()).to.contain('/login?redirect=');

    // TODO: maybe login with the new account
    // await new Promise(res => setTimeout(res, 12500));
  });
});
