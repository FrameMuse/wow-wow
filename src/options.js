const form = document.getElementById("settingsForm");
const statusEl = document.getElementById("status");
const verifyAuthBtn = document.getElementById("verifyAuthBtn");
const openPatPageBtn = document.getElementById("openPatPageBtn");
const clearFilesBtn = document.getElementById("clearFilesBtn");
const resumeFilesListEl = document.getElementById("resumeFilesList");

const RESUME_DOCS_KEY = "resumeDocs";

const controls = {
  bridgeUrl: document.getElementById("bridgeUrl"),
  githubToken: document.getElementById("githubToken"),
  model: document.getElementById("model"),
  resumeFiles: document.getElementById("resumeFiles"),
  resumeSource: document.getElementById("resumeSource"),
  qaHints: document.getElementById("qaHints"),
  allowAutoSubmit: document.getElementById("allowAutoSubmit"),
  assistUnfollowStayUpToDate: document.getElementById("assistUnfollowStayUpToDate"),
  assistSubmitForm: document.getElementById("assistSubmitForm"),
  assistAutofill: document.getElementById("assistAutofill"),
  assistTailorResume: document.getElementById("assistTailorResume")
};

let resumeDocs = [];

const DEFAULTS = {
  bridgeUrl: "http://127.0.0.1:8787/ai/json",
  githubToken: "",
  model: "gpt-5-mini",
  resumeSource: "",
  qaHints: "",
  allowAutoSubmit: false,
  assistOptions: {
    unfollowStayUpToDate: true,
    submitForm: false,
    autofillUnfilledFields: true,
    tailorResume: true
  }
};

async function loadSettings() {
  const [data, localData] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get({ [RESUME_DOCS_KEY]: [] })
  ]);

  resumeDocs = Array.isArray(localData[RESUME_DOCS_KEY]) ? localData[RESUME_DOCS_KEY] : [];

  controls.bridgeUrl.value = data.bridgeUrl;
  controls.githubToken.value = data.githubToken || "";
  controls.model.value = data.model;
  controls.resumeSource.value = data.resumeSource;
  controls.qaHints.value = data.qaHints;
  controls.allowAutoSubmit.checked = Boolean(data.allowAutoSubmit);
  const assistOptions = { ...DEFAULTS.assistOptions, ...(data.assistOptions || {}) };
  controls.assistUnfollowStayUpToDate.checked = Boolean(assistOptions.unfollowStayUpToDate);
  controls.assistSubmitForm.checked = Boolean(assistOptions.submitForm);
  controls.assistAutofill.checked = Boolean(assistOptions.autofillUnfilledFields);
  controls.assistTailorResume.checked = Boolean(assistOptions.tailorResume);
  renderResumeDocs();
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#8f1d1d" : "#1e5f35";
}

function validateJsonOrEmpty(value) {
  if (!value.trim()) {
    return "";
  }
  JSON.parse(value);
  return value;
}

function sanitizeDocs(inputDocs) {
  if (!Array.isArray(inputDocs)) {
    return [];
  }

  return inputDocs
    .filter((doc) => doc && typeof doc.name === "string" && typeof doc.content === "string")
    .map((doc) => ({
      name: doc.name,
      content: doc.content,
      updatedAt: doc.updatedAt || new Date().toISOString()
    }));
}

function renderResumeDocs() {
  const safeDocs = sanitizeDocs(resumeDocs);
  resumeDocs = safeDocs;

  if (!safeDocs.length) {
    resumeFilesListEl.textContent = "No files attached yet.";
    return;
  }

  const lines = safeDocs.map((doc, index) => {
    const lineCount = doc.content.split(/\r?\n/).length;
    return `${index + 1}. ${doc.name} (${lineCount} lines)`;
  });

  resumeFilesListEl.textContent = `${safeDocs.length} file(s) attached:\n${lines.join("\n")}`;
}

async function persistResumeDocs() {
  await chrome.storage.local.set({ [RESUME_DOCS_KEY]: sanitizeDocs(resumeDocs) });
}

async function importSelectedResumeFiles(files) {
  const toImport = Array.from(files || []).filter((file) => file.name.toLowerCase().endsWith(".md"));

  if (!toImport.length) {
    setStatus("Select at least one .md file.", true);
    return;
  }

  const imported = await Promise.all(
    toImport.map(async (file) => ({
      name: file.name,
      content: await file.text(),
      updatedAt: new Date().toISOString()
    }))
  );

  const byName = new Map(sanitizeDocs(resumeDocs).map((doc) => [doc.name, doc]));
  for (const doc of imported) {
    byName.set(doc.name, doc);
  }

  resumeDocs = Array.from(byName.values());
  await persistResumeDocs();
  renderResumeDocs();
  setStatus(`Imported ${imported.length} markdown file(s).`);
}

function collectSettingsFromForm() {
  return {
    bridgeUrl: controls.bridgeUrl.value.trim(),
    githubToken: controls.githubToken.value.trim(),
    model: controls.model.value.trim(),
    resumeSource: controls.resumeSource.value,
    qaHints: validateJsonOrEmpty(controls.qaHints.value),
    allowAutoSubmit: controls.allowAutoSubmit.checked,
    assistOptions: {
      unfollowStayUpToDate: controls.assistUnfollowStayUpToDate.checked,
      submitForm: controls.assistSubmitForm.checked,
      autofillUnfilledFields: controls.assistAutofill.checked,
      tailorResume: controls.assistTailorResume.checked
    }
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await chrome.storage.sync.set(collectSettingsFromForm());

    setStatus("Saved.");
    setTimeout(() => {
      setStatus("");
    }, 1400);
  } catch (error) {
    setStatus(`Invalid value: ${error.message}`, true);
  }
});

controls.resumeFiles.addEventListener("change", async (event) => {
  try {
    await importSelectedResumeFiles(event.target.files);
  } catch (error) {
    setStatus(`File import failed: ${error.message}`, true);
  } finally {
    controls.resumeFiles.value = "";
  }
});

clearFilesBtn.addEventListener("click", async () => {
  resumeDocs = [];
  await persistResumeDocs();
  renderResumeDocs();
  setStatus("Cleared attached markdown files.");
});

verifyAuthBtn.addEventListener("click", async () => {
  setStatus("Checking GitHub authorization...");

  try {
    const formSettings = collectSettingsFromForm();
    const result = await chrome.runtime.sendMessage({
      type: "check-github-auth",
      overrides: {
        bridgeUrl: formSettings.bridgeUrl,
        githubToken: formSettings.githubToken
      }
    });

    if (!result?.ok) {
      throw new Error(result?.error || "Authorization check failed.");
    }

    setStatus("GitHub authorization is valid and Copilot bridge is reachable.");
  } catch (error) {
    setStatus(`Auth check failed: ${error.message}`, true);
  }
});

openPatPageBtn.addEventListener("click", () => {
  chrome.tabs.create({
    url: "https://github.com/settings/personal-access-tokens/new"
  });
});

loadSettings();
