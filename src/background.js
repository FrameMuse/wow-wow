import { markdownToSimplePdfBytes } from "./lib/pdf.js";

const MEMORY_KEY = "lastAnalysisPayload";
const RESUME_DOCS_KEY = "resumeDocs";

function normalizeResumeDocs(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((doc) => doc && typeof doc.name === "string" && typeof doc.content === "string")
    .map((doc) => ({ name: doc.name, content: doc.content }));
}

function buildResumeSource(manualNotes, docs) {
  const chunks = [];

  for (const doc of normalizeResumeDocs(docs)) {
    chunks.push([`# Source: ${doc.name}`, doc.content.trim()].join("\n\n"));
  }

  if (String(manualNotes || "").trim()) {
    chunks.push(["# Additional Notes", String(manualNotes).trim()].join("\n\n"));
  }

  return chunks.join("\n\n---\n\n").trim();
}

function clipText(value, maxChars) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[truncated for speed]`;
}

async function getSettings({ requireResumeSource = true } = {}) {
  const defaults = {
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

  const [config, localData] = await Promise.all([
    chrome.storage.sync.get(defaults),
    chrome.storage.local.get({ [RESUME_DOCS_KEY]: [] })
  ]);

  const resumeDocs = normalizeResumeDocs(localData[RESUME_DOCS_KEY]);
  const mergedResumeSource = buildResumeSource(config.resumeSource, resumeDocs);

  if (!config.bridgeUrl) {
    throw new Error("Open settings and provide Copilot bridge URL.");
  }

  if (requireResumeSource && !mergedResumeSource) {
    throw new Error("Attach at least one markdown file or provide additional markdown notes in settings.");
  }

  return {
    ...config,
    resumeDocs,
    mergedResumeSource,
    qaHintsParsed: config.qaHints?.trim() ? JSON.parse(config.qaHints) : {}
  };
}

function buildBridgeRoute(bridgeUrl, routePath) {
  const url = new URL(bridgeUrl);
  url.pathname = routePath;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchBridgeJson(url, options, contextLabel) {
  try {
    const response = await fetch(url, options);
    return response;
  } catch (error) {
    throw new Error(
      `${contextLabel}: could not reach bridge at ${url}. Start it with \"bun run bridge\" (or \"node bridge/server.mjs\") and ensure this exact URL is set in extension settings.`
    );
  }
}

async function llmJsonCall({ bridgeUrl, githubToken, model, systemPrompt, userPrompt }) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (githubToken?.trim()) {
    headers["X-GitHub-Token"] = githubToken.trim();
  }

  const response = await fetchBridgeJson(
    bridgeUrl,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        responseType: "json",
        systemPrompt,
        userPrompt
      })
    },
    "Copilot bridge call failed"
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Copilot bridge call failed (${response.status}): ${errorText.slice(0, 400)}`);
  }

  const payload = await response.json();
  const content = payload?.content;

  if (!content) {
    throw new Error("Empty LLM response content.");
  }

  if (typeof content === "object") {
    return content;
  }

  return JSON.parse(content);
}

async function checkGithubAuth(overrides = {}) {
  const settings = await getSettings({ requireResumeSource: false });
  const bridgeUrl = String(overrides.bridgeUrl || settings.bridgeUrl || "").trim();
  const githubToken = String(overrides.githubToken || settings.githubToken || "").trim();

  if (!bridgeUrl) {
    throw new Error("Copilot bridge URL is empty.");
  }

  const authCheckUrl = buildBridgeRoute(bridgeUrl, "/auth/check");
  const healthUrl = buildBridgeRoute(bridgeUrl, "/health");

  const headers = {
    "Content-Type": "application/json"
  };

  if (githubToken?.trim()) {
    headers["X-GitHub-Token"] = githubToken.trim();
  }

  const health = await fetchBridgeJson(
    healthUrl,
    {
      method: "GET",
      headers
    },
    "Bridge health check failed"
  );

  if (!health.ok) {
    const errorText = await health.text();
    throw new Error(`Bridge health check failed (${health.status}): ${errorText.slice(0, 300)}`);
  }

  const response = await fetchBridgeJson(
    authCheckUrl,
    {
      method: "POST",
      headers,
      body: JSON.stringify({})
    },
    "Bridge auth check failed"
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bridge auth check failed (${response.status}): ${errorText.slice(0, 300)}`);
  }

  return response.json();
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

function toBase64(uint8Array) {
  let binary = "";
  for (const byte of uint8Array) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function analyzeJobFit(jobContext) {
  if (jobContext?.ghostAssessment?.shouldAvoid) {
    const reasons = Array.isArray(jobContext.ghostAssessment.signals)
      ? jobContext.ghostAssessment.signals.join(" ")
      : "Posting quality appears low.";
    throw new Error(`Posting flagged as likely ghost job (risk ${jobContext.ghostAssessment.riskScore}/100). ${reasons}`);
  }

  const settings = await getSettings();
  const { bridgeUrl, githubToken, model, mergedResumeSource, qaHintsParsed } = settings;

  const compactResumeSource = clipText(mergedResumeSource, 20000);
  const compactJobContext = {
    ...jobContext,
    description: clipText(jobContext?.description, 4500)
  };

  const systemPrompt = [
    "You are an honest career copilot.",
    "Use only evidence from the candidate background.",
    "Return JSON with keys: fitScore (0-100 integer), reasoning (string), mustHaveMatch (string), niceToHaveMatch (string), tailoredResumeMarkdown (string), applicationAnswers (object mapping question themes to truthful persuasive answers).",
    "Do not fabricate skills or experience."
  ].join(" ");

  const userPrompt = [
    "Candidate experience markdown:",
    compactResumeSource,
    "",
    "Job context JSON:",
    JSON.stringify(compactJobContext, null, 2),
    "",
    "Helpful Q&A hints JSON:",
    JSON.stringify(qaHintsParsed, null, 2),
    "",
    "Produce a tailored resume in markdown optimized for this role while staying truthful."
  ].join("\n");

  const parsed = await llmJsonCall({ bridgeUrl, githubToken, model, systemPrompt, userPrompt });

  const analysisPayload = {
    jobContext,
    fitScore: Number(parsed.fitScore) || 0,
    reasoning: String(parsed.reasoning || "No reasoning provided."),
    mustHaveMatch: String(parsed.mustHaveMatch || "Unknown"),
    niceToHaveMatch: String(parsed.niceToHaveMatch || "Unknown"),
    tailoredResumeMarkdown: String(parsed.tailoredResumeMarkdown || ""),
    applicationAnswers: parsed.applicationAnswers || {},
    generatedAt: new Date().toISOString()
  };

  await chrome.storage.local.set({ [MEMORY_KEY]: analysisPayload });

  return analysisPayload;
}

async function generateResumePdf() {
  const data = await chrome.storage.local.get(MEMORY_KEY);
  const payload = data[MEMORY_KEY];

  if (!payload?.tailoredResumeMarkdown) {
    throw new Error("Analyze a job first to generate tailored resume markdown.");
  }

  const pdfBytes = markdownToSimplePdfBytes(payload.tailoredResumeMarkdown);
  const title = payload.jobContext?.title || "resume";
  const company = payload.jobContext?.company || "company";
  const fileName = `resume-${slugify(title)}-${slugify(company)}.pdf`;

  const result = {
    ...payload,
    resumePdfBase64: toBase64(pdfBytes),
    resumePdfMime: "application/pdf",
    resumePdfName: fileName
  };

  await chrome.storage.local.set({ [MEMORY_KEY]: result });

  return { fileName };
}

async function getApplicationPayload(assistOverrides = {}) {
  const settings = await getSettings();
  const assistOptions = {
    ...settings.assistOptions,
    ...assistOverrides,
    submitForm: Boolean(assistOverrides.submitForm ?? settings.assistOptions?.submitForm ?? settings.allowAutoSubmit)
  };

  if (assistOptions.tailorResume) {
    await generateResumePdf();
  }

  const data = await chrome.storage.local.get(MEMORY_KEY);
  const payload = data[MEMORY_KEY];

  if (!payload?.resumePdfBase64) {
    throw new Error("No recent resume PDF found. Analyze and generate first, or enable Tailor resume before assist.");
  }

  return {
    resumePdfBase64: payload.resumePdfBase64,
    resumePdfMime: payload.resumePdfMime,
    resumePdfName: payload.resumePdfName,
    applicationAnswers: payload.applicationAnswers,
    allowAutoSubmit: assistOptions.submitForm,
    assistOptions
  };
}

async function llmTextCall({ bridgeUrl, githubToken, model, action, selectionText, label }) {
  const labelContext = label ? `Field: "${label}"\n\n` : "";

  const systemPrompt =
    action === "resume-improve"
      ? 'You are a professional resume and job application writer. Improve the provided text to be more professional, impactful, and concise. Return JSON: {"text": "<improved text>"}. Output only the JSON, no explanations.'
      : 'You are a professional resume and job application writer. Continue and complete the provided text naturally and professionally. Return JSON: {"text": "<full completed text including the original start>"}. Output only the JSON, no explanations.';

  const userPrompt = `${labelContext}${action === "resume-improve" ? "Improve" : "Complete"} this text:\n\n${selectionText}`;

  const result = await llmJsonCall({ bridgeUrl, githubToken, model, systemPrompt, userPrompt });
  const text = result?.text;

  if (!text || typeof text !== "string") {
    throw new Error("LLM returned an empty or invalid text result.");
  }

  return text;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "resume-improve",
    title: "[Resume] Improve",
    contexts: ["editable"]
  });
  chrome.contextMenus.create({
    id: "resume-autocomplete",
    title: "[Resume] Autocomplete",
    contexts: ["editable"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !["resume-improve", "resume-autocomplete"].includes(String(info.menuItemId))) {
    return;
  }

  const selectionText = info.selectionText?.trim();
  if (!selectionText) {
    return;
  }

  try {
    let label = "";
    try {
      const ctx = await chrome.tabs.sendMessage(tab.id, { type: "resume-get-field-context" });
      label = ctx?.label || "";
    } catch {
      // content script may not be available on this tab
    }

    const settings = await getSettings({ requireResumeSource: false });
    const newText = await llmTextCall({
      bridgeUrl: settings.bridgeUrl,
      githubToken: settings.githubToken,
      model: settings.model,
      action: String(info.menuItemId),
      selectionText,
      label
    });

    await chrome.tabs.sendMessage(tab.id, { type: "resume-text-replace", newText });
  } catch (error) {
    chrome.tabs.sendMessage(tab.id, { type: "resume-text-error", error: error.message }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "analyze-job-fit") {
      const analysis = await analyzeJobFit(message.jobContext);
      sendResponse({ ok: true, data: analysis });
      return;
    }

    if (message.type === "generate-resume-pdf") {
      const data = await generateResumePdf();
      sendResponse({ ok: true, data });
      return;
    }

    if (message.type === "get-application-payload") {
      const data = await getApplicationPayload(message.assistOptions || {});
      sendResponse({ ok: true, data });
      return;
    }

    if (message.type === "check-github-auth") {
      const data = await checkGithubAuth(message.overrides || {});
      sendResponse({ ok: true, data });
      return;
    }

    sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message });
  });

  return true;
});
