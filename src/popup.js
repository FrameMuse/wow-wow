const assistBtn = document.getElementById("assistBtn");
const openOptionsBtn = document.getElementById("openOptions");

const controls = {
  unfollowStayUpToDate: document.getElementById("assistUnfollowStayUpToDate"),
  submitForm: document.getElementById("assistSubmitForm"),
  autofillUnfilledFields: document.getElementById("assistAutofill"),
  tailorResume: document.getElementById("assistTailorResume")
};

const SUPPORTED_HOSTS = ["linkedin.com", "indeed.com"];
const ASSIST_DEFAULTS = {
  unfollowStayUpToDate: true,
  submitForm: false,
  autofillUnfilledFields: true,
  tailorResume: true
};

function setBusy(isBusy) {
  if (assistBtn) {
    assistBtn.disabled = isBusy;
    assistBtn.textContent = isBusy ? "Assisting..." : "Assist Easy Apply Form";
  }
}

function isReceiverMissingError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  return text.includes("receiving end does not exist") || text.includes("could not establish connection");
}

function isSupportedHost(urlString) {
  try {
    const host = new URL(urlString).hostname.toLowerCase();
    return SUPPORTED_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

async function withActiveTab(fn) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }
  return fn(tab);
}

async function ensureContentScript(tab) {
  if (!isSupportedHost(tab.url || "")) {
    throw new Error("Open a LinkedIn or Indeed job page first.");
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content.js"]
  });
}

async function sendMessageToTab(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!isReceiverMissingError(error)) {
      throw error;
    }

    await ensureContentScript(tab);
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

async function sendToBackground(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function collectAssistOptions() {
  return {
    unfollowStayUpToDate: Boolean(controls.unfollowStayUpToDate?.checked),
    submitForm: Boolean(controls.submitForm?.checked),
    autofillUnfilledFields: Boolean(controls.autofillUnfilledFields?.checked),
    tailorResume: Boolean(controls.tailorResume?.checked)
  };
}

async function loadAssistOptions() {
  const data = await chrome.storage.sync.get({ assistOptions: ASSIST_DEFAULTS });
  const assistOptions = { ...ASSIST_DEFAULTS, ...(data.assistOptions || {}) };

  if (controls.unfollowStayUpToDate) controls.unfollowStayUpToDate.checked = Boolean(assistOptions.unfollowStayUpToDate);
  if (controls.submitForm) controls.submitForm.checked = Boolean(assistOptions.submitForm);
  if (controls.autofillUnfilledFields) controls.autofillUnfilledFields.checked = Boolean(assistOptions.autofillUnfilledFields);
  if (controls.tailorResume) controls.tailorResume.checked = Boolean(assistOptions.tailorResume);
}

async function saveAssistOptions() {
  await chrome.storage.sync.set({ assistOptions: collectAssistOptions() });
}

for (const control of Object.values(controls)) {
  control?.addEventListener("change", () => {
    saveAssistOptions().catch(() => undefined);
  });
}

assistBtn?.addEventListener("click", async () => {
  setBusy(true);

  try {
    const assistOptions = collectAssistOptions();
    await saveAssistOptions();

    const payload = await sendToBackground("get-application-payload", { assistOptions });
    if (!payload?.ok) {
      throw new Error(payload?.error || "No application payload available.");
    }

    const assistResult = await withActiveTab((tab) =>
      sendMessageToTab(tab, {
        type: "assist-application",
        data: payload.data
      })
    );

    if (!assistResult?.ok) {
      throw new Error(assistResult?.error || "Assist step failed.");
    }
  } catch (error) {
    console.error("Assist failed:", error);
  } finally {
    setBusy(false);
  }
});

openOptionsBtn?.addEventListener("click", () => chrome.runtime.openOptionsPage());

loadAssistOptions().catch(() => undefined);
