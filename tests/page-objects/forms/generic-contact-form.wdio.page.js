const mutedModalSelector = '.modal-content #contacts-muted';

const openForm = async (formId) => {
  const addButton = await $('.detail-actions .actions .dropdown-toggle .fa-plus');
  await addButton.click();
  const form = await $(`#relevant-contacts-form li[id="form:${formId}"] a`);
  await form.click();
};

module.exports.openForm = async (formId) => {
  await openForm(formId);
  const formTitle = await $('#form-title');
  await formTitle.waitForDisplayed();
};

module.exports.submit = async () => {
  const submitButton = await $('.btn.submit.btn-primary');
  await submitButton.click();
  const flexGrid = await $(('div.row.flex.grid'));
  await flexGrid.waitForDisplayed(); // contact summary loaded
};

module.exports.openFormForMutedContact = async (formId) => {
  await openForm(formId);
  // popup is shown instead of form
  const mutedModal = await $(mutedModalSelector);
  await mutedModal.waitForDisplayed();
};

module.exports.closeModal = async (confirm) => {
  const modalAcceptButton = await $(`${mutedModalSelector} .modal-footer .btn.submit`);
  if (confirm) {
    await modalAcceptButton.click();
    await (await $('#form-title')).waitForDisplayed();
    return;
  }
  const modalCancelButton = await $(`${mutedModalSelector} .modal-footer .btn.cancel`);
  await modalCancelButton.click();
  await browser.pause(1000); // nothing should happen, but let's wait and make sure no redirection takes place
};
