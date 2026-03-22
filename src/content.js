function cleanText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

const REVIEW_WIDGET_ID = "easy-apply-copilot-review";
const AVOID_OVERLAY_CLASS = "easy-apply-copilot-avoid-overlay";
const DISMISS_OVERLAY_CLASS = "easy-apply-copilot-dismiss-overlay";
const REVIEW_DEFAULT_MESSAGE = "Use Analyze Job first, then generate a tailored resume for this posting.";
const LIST_STATS_ID = "easy-apply-copilot-list-stats";
const STATIC_ANALYSIS_TELEMETRY_KEY = "easyApplyStaticMetricsLogV1";
const STATIC_ANALYSIS_TELEMETRY_LIMIT = 300;

const STATIC_ANALYSIS_THRESHOLDS = {
  warn: 35,
  cover: 55,
  dismiss: 78
};

const STATIC_ANALYSIS_WEIGHTS = {
  aiTrainingData: 24,
  knownCompanyFlag: 26,
  candidateQualificationFreeTask: 22,
  timedCandidateTaskUnder60: 12,
  candidateQualificationTask: 8,
  automatedAiInterviewingStep: 10,
  referralHarvesting: 10,
  externalInterviewRedirect: 12,
  impossibleRole: 20,
  highCompOutlier: 8,
  aiDomainFound: 8,
  ghostJob: 14,
  shortDescription: 7,
  missingCompanyName: 9
};

const staticTelemetrySignatureCache = new Set();

const linkedInReviewCache = {
  staticBySignature: new Map(),
  llmBySignature: new Map(),
  pendingBySignature: new Map(),
  analyzedBySignature: new Set()
};

function ensureRelativePosition(element) {
  const computed = getComputedStyle(element).position;
  if (computed === "static") {
    element.dataset.easyApplyOriginalPosition = "static";
    element.style.position = "relative";
  }
}

function removeRelativePositionIfOwned(element) {
  if (element.dataset.easyApplyOriginalPosition === "static") {
    element.style.position = "";
    delete element.dataset.easyApplyOriginalPosition;
  }
}

function setCoveredState(target, covered, labelText) {
  const cachedOverlay = target.__easyApplyCoverOverlay;
  const existingOverlay = cachedOverlay?.isConnected
    ? cachedOverlay
    : target.querySelector(`.${AVOID_OVERLAY_CLASS}`);

  if (existingOverlay?.isConnected) {
    target.__easyApplyCoverOverlay = existingOverlay;
  }

  if (!covered) {
    if (existingOverlay) {
      existingOverlay.remove();
    }
    target.__easyApplyCoverOverlay = null;
    if (target.dataset.easyApplyCovered === "1") {
      target.style.filter = "";
      target.style.opacity = "";
      target.style.pointerEvents = "";
      delete target.dataset.easyApplyCovered;
      removeRelativePositionIfOwned(target);
    }
    return;
  }

  ensureRelativePosition(target);
  target.style.filter = "grayscale(1) blur(1px)";
  target.style.opacity = "0.22";
  target.style.pointerEvents = "none";
  target.dataset.easyApplyCovered = "1";

  const overlay = existingOverlay || document.createElement("div");
  overlay.className = AVOID_OVERLAY_CLASS;
  overlay.textContent = labelText || "Avoided by static scam/ghost filter";
  overlay.style.position = "absolute";
  overlay.style.inset = "0";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.background = "rgba(20, 24, 30, 0.82)";
  overlay.style.color = "#fff";
  overlay.style.fontWeight = "700";
  overlay.style.fontSize = "13px";
  overlay.style.textAlign = "center";
  overlay.style.padding = "12px";
  overlay.style.borderRadius = "inherit";
  overlay.style.zIndex = "20";
  overlay.style.pointerEvents = "none";

  if (!overlay.isConnected) {
    target.appendChild(overlay);
  }

  target.__easyApplyCoverOverlay = overlay;
}

function listCardElements() {
  return Array.from(
    document.querySelectorAll(".jobs-search-results__list-item, .jobs-search-results-list__list-item, .job-card-container")
  );
}

function isCardHidden(card) {
  if (!card || !card.isConnected) {
    return true;
  }

  if (card.dataset.easyApplyDismissState === "done" || card.style.display === "none") {
    return true;
  }

  if (card.dataset.easyApplyCovered === "1") {
    return true;
  }

  const computed = getComputedStyle(card);
  return computed.display === "none" || computed.visibility === "hidden";
}

function ensureLinkedInListStatsWidget() {
  const header = document.querySelector(".scaffold-layout__list-header");
  if (!header) {
    return null;
  }

  let widget = document.getElementById(LIST_STATS_ID);
  if (widget?.isConnected) {
    return widget;
  }

  widget = document.createElement("div");
  widget.id = LIST_STATS_ID;
  widget.style.padding = "4px 8px";
  widget.style.background = "hsl(210, 90%, 30%)";
  widget.style.fontSize = "12px";
  widget.style.fontWeight = "500";
  widget.style.color = "white";
  widget.style.lineHeight = "1.4";

  if (header.parentElement) {
    header.parentElement.insertBefore(widget, header.nextSibling);
  }

  return widget;
}

function updateLinkedInListStats() {
  if (!location.hostname.includes("linkedin.com")) {
    return;
  }

  const widget = ensureLinkedInListStatsWidget();
  if (!widget) {
    return;
  }

  const cards = listCardElements();
  const total = cards.length;
  const hidden = cards.filter((card) => isCardHidden(card)).length;
  const shown = Math.max(0, total - hidden);

  widget.textContent = `Shown: ${shown} | Hidden: ${hidden} | Total: ${total}`;
}

function textFromSelectors(selectors, root = document) {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    const text = cleanText(el?.textContent || "");
    if (text) {
      return text;
    }
  }
  return "";
}

function firstElement(selectors, root = document) {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    if (el) {
      return el;
    }
  }
  return null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function confidenceBand(value) {
  if (value >= 80) {
    return "high";
  }
  if (value >= 60) {
    return "medium";
  }
  return "low";
}

function evaluateStaticAction(score, signals) {
  const hardDismiss = Boolean(signals.knownCompanyFlag || signals.aiTrainingData);
  if (hardDismiss || score >= STATIC_ANALYSIS_THRESHOLDS.dismiss) {
    return "dismiss";
  }
  if (score >= STATIC_ANALYSIS_THRESHOLDS.cover) {
    return "cover";
  }
  if (score >= STATIC_ANALYSIS_THRESHOLDS.warn) {
    return "warn";
  }
  return "allow";
}

function buildStaticRiskModel({ signals, featureVector }) {
  const weightedEntries = Object.entries(STATIC_ANALYSIS_WEIGHTS).map(([name, weight]) => {
    const active = Boolean(signals[name] || featureVector[name]);
    return {
      name,
      weight,
      active,
      contribution: active ? weight : 0
    };
  });

  const rawScore = weightedEntries.reduce((sum, entry) => sum + entry.contribution, 0);
  const maxScore = weightedEntries.reduce((sum, entry) => sum + entry.weight, 0) || 1;
  const riskScore = Math.round((rawScore / maxScore) * 100);

  const margins = [
    Math.abs(riskScore - STATIC_ANALYSIS_THRESHOLDS.warn),
    Math.abs(riskScore - STATIC_ANALYSIS_THRESHOLDS.cover),
    Math.abs(riskScore - STATIC_ANALYSIS_THRESHOLDS.dismiss)
  ];
  const nearestMargin = Math.min(...margins);
  const activeCount = weightedEntries.filter((entry) => entry.active).length;
  const confidence = clamp(Math.round(42 + activeCount * 7 + nearestMargin * 0.55), 5, 99);
  const action = evaluateStaticAction(riskScore, signals);

  const topDrivers = weightedEntries
    .filter((entry) => entry.active)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map((entry) => entry.name);

  return {
    riskScore,
    confidence,
    confidenceBand: confidenceBand(confidence),
    action,
    topDrivers,
    weightedEntries
  };
}

function recordStaticAssessmentTelemetry(signature, context, assessment, surface) {
  if (!signature) {
    return;
  }

  const cacheKey = `${surface}:${signature}`;
  if (staticTelemetrySignatureCache.has(cacheKey)) {
    return;
  }
  staticTelemetrySignatureCache.add(cacheKey);

  const entry = {
    ts: Date.now(),
    surface,
    source: cleanText(context?.source || "unknown"),
    title: cleanText(context?.title).slice(0, 140),
    company: cleanText(context?.company).slice(0, 120),
    url: cleanText(context?.url).slice(0, 220),
    riskScore: assessment.riskScore,
    confidence: assessment.riskConfidence,
    confidenceBand: assessment.riskConfidenceBand,
    action: assessment.decision?.action || "allow",
    topDrivers: assessment.decision?.topDrivers || [],
    signals: assessment.signals,
    featureVector: assessment.featureVector
  };

  try {
    const raw = localStorage.getItem(STATIC_ANALYSIS_TELEMETRY_KEY);
    const existing = raw ? JSON.parse(raw) : [];
    const next = Array.isArray(existing) ? existing : [];
    next.push(entry);
    if (next.length > STATIC_ANALYSIS_TELEMETRY_LIMIT) {
      next.splice(0, next.length - STATIC_ANALYSIS_TELEMETRY_LIMIT);
    }
    localStorage.setItem(STATIC_ANALYSIS_TELEMETRY_KEY, JSON.stringify(next));
  } catch {
    // Telemetry is best effort; do not impact scanning flow.
  }
}

function parseRelativeDays(text) {
  const normalized = cleanText(text).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized.includes("today") || normalized.includes("just now")) {
    return 0;
  }

  const dayMatch = normalized.match(/(\d+)\s+day/);
  if (dayMatch) {
    return Number(dayMatch[1]);
  }

  const weekMatch = normalized.match(/(\d+)\s+week/);
  if (weekMatch) {
    return Number(weekMatch[1]) * 7;
  }

  const monthMatch = normalized.match(/(\d+)\s+month/);
  if (monthMatch) {
    return Number(monthMatch[1]) * 30;
  }

  return null;
}

function assessGhostRisk({ title, company, description, postedAtText }) {
  const signals = [];
  let riskScore = 0;

  const normalizedDescription = cleanText(description).toLowerCase();
  const normalizedTitle = cleanText(title).toLowerCase();
  const normalizedCompany = cleanText(company).toLowerCase();

  const suspiciousPhrases = [
    "evergreen requisition",
    "pipeline role",
    "talent pipeline",
    "future opportunity",
    "future opportunities",
    "not actively hiring",
    "resume database",
    "talent pool",
    "for future consideration",
    "not a current opening"
  ];

  if (normalizedDescription.length < 300) {
    riskScore += 30;
    signals.push("Description is unusually short for a real opening.");
  }

  if (!normalizedCompany || normalizedCompany.length < 2) {
    riskScore += 20;
    signals.push("Company name is missing or unclear.");
  }

  if (normalizedTitle.includes("general application") || normalizedTitle.includes("open application")) {
    riskScore += 35;
    signals.push("Title suggests a generic application pool role.");
  }

  for (const phrase of suspiciousPhrases) {
    if (normalizedDescription.includes(phrase)) {
      riskScore += 35;
      signals.push(`Description contains ghost-job phrase: \"${phrase}\".`);
      break;
    }
  }

  const postedDays = parseRelativeDays(postedAtText);
  if (Number.isFinite(postedDays) && postedDays > 45) {
    riskScore += 25;
    signals.push(`Posting appears old (${postedDays} days).`);
  }

  const shouldAvoid = riskScore >= 55;

  return {
    riskScore,
    shouldAvoid,
    signals,
    postedAtText: cleanText(postedAtText)
  };
}

function extractUrlsFromText(text) {
  const input = String(text || "");
  const matches = input.match(/https?:\/\/[^\s)]+/gi) || [];
  return matches.map((item) => item.trim().replace(/[.,;!?]+$/, ""));
}

function extractDomains(urls) {
  const result = [];
  for (const url of urls) {
    try {
      result.push(new URL(url).hostname.toLowerCase());
    } catch {
      // Ignore malformed URL text snippets.
    }
  }
  return result;
}

function includesAny(text, needles) {
  const source = String(text || "").toLowerCase();
  return needles.some((needle) => source.includes(needle));
}

function detectCompensationOutlier(text) {
  const source = String(text || "");
  const ranges = source.match(/\$\s*\d{2,4}\s*(?:-|to)\s*\$\s*\d{2,4}\s*(?:\/\s*h|\/\s*hr|per hour|hourly)?/gi) || [];
  for (const chunk of ranges) {
    const nums = chunk.match(/\d{2,4}/g) || [];
    if (nums.length < 2) {
      continue;
    }
    const high = Math.max(Number(nums[0]), Number(nums[1]));
    if (high >= 150) {
      return true;
    }
  }
  return false;
}

function detectTimedTaskUnderMinutes(text, limitMinutes = 60) {
  const source = String(text || "").toLowerCase();

  const minuteMatches = source.match(/(\d{1,3})\s*(?:minutes|minute|mins|min)\b/g) || [];
  for (const chunk of minuteMatches) {
    const num = Number((chunk.match(/\d{1,3}/) || ["0"])[0]);
    if (num > 0 && num <= limitMinutes) {
      return true;
    }
  }

  if (source.includes("1 hour") || source.includes("one hour") || source.includes("60 min") || source.includes("60-minute")) {
    return true;
  }

  return false;
}

function detectAiDrivenProductClaim(text) {
  const source = String(text || "").toLowerCase();
  if (!source) {
    return false;
  }

  const aiTerms = [
    "ai",
    "artificial intelligence",
    "machine learning",
    "llm",
    "generative ai",
    "genai"
  ];

  const productTerms = [
    "our product",
    "our platform",
    "our solution",
    "our tool",
    "our app",
    "we build",
    "we are building",
    "ai-powered product",
    "ai powered product",
    "ai-powered platform",
    "ai powered platform",
    "ai product",
    "ai platform"
  ];

  const hasAiReference = includesAny(source, aiTerms);
  const hasProductClaim = includesAny(source, productTerms);

  if (hasAiReference && hasProductClaim) {
    return true;
  }

  return /(product|platform|solution|tool|app).{0,40}(artificial intelligence|machine learning|generative ai|genai|\bai\b)/.test(source);
}

function assessScamSignals({ title, company, description, url, ghostAssessment }) {
  const merged = [title, company, description, url].map((x) => String(x || "")).join("\n");
  const urls = extractUrlsFromText(merged);
  const domains = extractDomains(urls);

  const aiTrainingHints = [
    "training data",
    "collect video",
    "recorded interview",
    "one-way interview",
    "asynchronous interview",
    "ai interview",
    "evaluate your video",
    "voice sample",
    "evaluator",
    "improve AI",
  ];

  const referralHarvestHints = [
    "referral bonus",
    "referral fee",
    "refer candidates",
    "candidate referrals",
    "high-volume hiring"
  ];

  const knownQuestionableCompanies = ["mercor", "micro1", "crossing hurdles"];

  const domainAi = domains.some((domain) => domain.endsWith(".ai"));
  const knownCompanyMention = includesAny(merged, knownQuestionableCompanies);
  const aiTrainingDataSignal = includesAny(merged, aiTrainingHints);
  const referralHarvestingSignal = includesAny(merged, referralHarvestHints);
  const automatedAiInterviewingStepSignal = includesAny(merged, [
    "automated interview",
    "ai interviewing",
    "ai interview",
    "asynchronous interview",
    "one-way interview",
    "record your interview",
    "video interview platform",
    "bot interview",
    "automated screening",
    "ai screening",
    "ai to match"
  ]);
  const impossibleRoleSignal = includesAny(title, ["nuclear reactor operator", "air traffic controller", "surgeon"]) && includesAny(title, ["remote"]);
  const compensationOutlierSignal = detectCompensationOutlier(merged);
  const externalInterviewRedirectSignal = includesAny(merged, ["complete interview", "external interview", "assessment platform", "interview platform"]);
  const candidateQualificationTaskSignal = includesAny(merged, [
    "candidate qualification",
    "qualification task",
    "coding challenge",
    "code challenge",
    "take-home task",
    "take home task",
    "complete task",
    "submit your solution",
    "codewars",
    "leetcode",
    "hackerrank"
  ]);
  const timedCandidateTaskUnder60Signal = candidateQualificationTaskSignal && detectTimedTaskUnderMinutes(merged, 60);
  const freeTaskSignal = includesAny(merged, [
    "unpaid",
    "free task",
    "no compensation",
    "without compensation",
    "volunteer task",
    "pro bono"
  ]);
  const candidateQualificationFreeTaskSignal = candidateQualificationTaskSignal && (freeTaskSignal || !includesAny(merged, ["paid", "compensated", "compensation"])) && timedCandidateTaskUnder60Signal;
  const aiDrivenProductSignal = detectAiDrivenProductClaim(merged);

  const likelyGhost = Boolean(ghostAssessment?.shouldAvoid);
  const shortDescriptionSignal = cleanText(description).length < 300;
  const missingCompanySignal = cleanText(company).length < 2;

  const signals = {
    aiTrainingData: aiTrainingDataSignal,
    aiDrivenProduct: aiDrivenProductSignal,
    automatedAiInterviewingStep: automatedAiInterviewingStepSignal,
    candidateQualificationTask: candidateQualificationTaskSignal,
    timedCandidateTaskUnder60: timedCandidateTaskUnder60Signal,
    candidateQualificationFreeTask: candidateQualificationFreeTaskSignal,
    ghostJob: likelyGhost,
    aiDomainFound: domainAi,
    knownCompanyFlag: knownCompanyMention,
    referralHarvesting: referralHarvestingSignal,
    impossibleRole: impossibleRoleSignal,
    highCompOutlier: compensationOutlierSignal,
    externalInterviewRedirect: externalInterviewRedirectSignal,
    shortDescription: shortDescriptionSignal,
    missingCompanyName: missingCompanySignal
  };

  const featureVector = {
    ...Object.fromEntries(Object.entries(signals).map(([name, active]) => [name, active ? 1 : 0])),
    postedDays: Number.isFinite(parseRelativeDays(ghostAssessment?.postedAtText || ""))
      ? parseRelativeDays(ghostAssessment?.postedAtText || "")
      : -1,
    descriptionLength: cleanText(description).length,
    domainCount: domains.length
  };

  const model = buildStaticRiskModel({ signals, featureVector });
  const likelyScam = model.action !== "allow";
  const hardAvoid = model.action === "dismiss" || model.action === "cover";
  const scamRiskSignal = model.action !== "allow";

  return {
    riskScore: model.riskScore,
    riskConfidence: model.confidence,
    riskConfidenceBand: model.confidenceBand,
    likelyScam,
    likelyGhost,
    hardAvoid,
    signals: {
      ...signals,
      scamRisk: scamRiskSignal
    },
    featureVector,
    decision: {
      action: model.action,
      topDrivers: model.topDrivers,
      thresholds: STATIC_ANALYSIS_THRESHOLDS
    },
    domains
  };
}

function buildHardAvoidReason(scam) {
  const reasons = [];
  if (scam.signals.aiTrainingData) {
    reasons.push("AI training data signal");
  }
  if (scam.signals.knownCompanyFlag) {
    reasons.push("flagged company mention");
  }
  if (scam.signals.candidateQualificationFreeTask) {
    reasons.push("timed free qualification task");
  }
  if (Array.isArray(scam.decision?.topDrivers) && scam.decision.topDrivers.length) {
    reasons.push(`drivers: ${scam.decision.topDrivers.join(", ")}`);
  }
  return reasons.join(" + ") || "high scam/ghost risk";
}

function findDismissButton(card) {
  const selectors = [
    "button[aria-label*='dismiss']",
    "button[aria-label*='not interested']",
    "button[aria-label*='hide']",
    "button[aria-label*='remove']",
    "button[aria-label*='Dismiss']",
    "button[aria-label*='Not interested']",
    "button[aria-label*='Hide']",
    "button[aria-label*='Remove']"
  ];

  for (const selector of selectors) {
    const button = card.querySelector(selector);
    if (button) {
      return button;
    }
  }

  const textMatch = Array.from(card.querySelectorAll("button, [role='button']")).find((el) => {
    const label = cleanText(el.textContent || el.getAttribute("aria-label") || "").toLowerCase();
    return ["dismiss", "not interested", "hide", "remove"].some((needle) => label.includes(needle));
  });

  return textMatch || null;
}

function isAlreadyAppliedCard(card, context) {
  const appliedSelectors = [
    ".job-card-container__footer-job-state",
    ".job-card-container__applied-text",
    ".job-card-list__footer-wrapper",
    ".artdeco-entity-lockup__caption"
  ];

  const selectorText = appliedSelectors
    .map((selector) => cleanText(card.querySelector(selector)?.textContent || ""))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const merged = [
    cleanText(context?.title),
    cleanText(context?.company),
    cleanText(context?.description),
    selectorText,
    cleanText(card.textContent || "")
  ].join(" ").toLowerCase();

  return [
    "applied",
    "application submitted",
    "already applied",
    "submitted"
  ].some((needle) => merged.includes(needle));
}

function animateAndDismissAppliedCard(card) {
  if (card.dataset.easyApplyDismissState === "done" || card.dataset.easyApplyDismissState === "running") {
    return;
  }

  card.dataset.easyApplyDismissState = "running";
  ensureRelativePosition(card);

  const dismissButton = findDismissButton(card);
  const overlay = document.createElement("div");
  overlay.className = DISMISS_OVERLAY_CLASS;
  overlay.textContent = "Auto-dismissing already applied job";
  overlay.style.position = "absolute";
  overlay.style.inset = "0";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.background = "rgba(22, 101, 52, 0.9)";
  overlay.style.color = "#fff";
  overlay.style.fontWeight = "700";
  overlay.style.fontSize = "13px";
  overlay.style.textAlign = "center";
  overlay.style.padding = "12px";
  overlay.style.zIndex = "30";
  overlay.style.pointerEvents = "none";

  if (!overlay.isConnected) {
    card.appendChild(overlay);
  }

  const initialHeight = Math.max(card.getBoundingClientRect().height, 48);
  card.style.overflow = "hidden";
  card.style.maxHeight = `${initialHeight}px`;
  card.style.transition = "opacity 500ms ease, max-height 500ms ease, margin 500ms ease, padding 500ms ease";

  requestAnimationFrame(() => {
    card.style.opacity = "0";
    card.style.maxHeight = "0px";
    card.style.marginTop = "0";
    card.style.marginBottom = "0";
    card.style.paddingTop = "0";
    card.style.paddingBottom = "0";
  });

  card.addEventListener("transitionend", () => {
    if (dismissButton && dismissButton.isConnected) {
      dismissButton.click();
    }
    card.dataset.easyApplyDismissState = "done";
    card.style.display = "none";
  }, { once: true });
}

function animateAndDismissFlaggedCard(card, reasonText) {
  if (card.dataset.easyApplyDismissState === "done" || card.dataset.easyApplyDismissState === "running") {
    return;
  }

  card.dataset.easyApplyDismissState = "running";
  ensureRelativePosition(card);

  const dismissButton = findDismissButton(card);
  const overlay = document.createElement("div");
  overlay.className = DISMISS_OVERLAY_CLASS;
  overlay.textContent = `Auto-dismissing flagged company (${reasonText})`;
  overlay.style.position = "absolute";
  overlay.style.inset = "0";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.background = "rgba(180, 28, 28, 0.9)";
  overlay.style.color = "#fff";
  overlay.style.fontWeight = "700";
  overlay.style.fontSize = "13px";
  overlay.style.textAlign = "center";
  overlay.style.padding = "12px";
  overlay.style.zIndex = "30";
  overlay.style.pointerEvents = "none";

  if (!overlay.isConnected) {
    card.appendChild(overlay);
  }

  const initialHeight = Math.max(card.getBoundingClientRect().height, 48);
  card.style.overflow = "hidden";
  card.style.maxHeight = `${initialHeight}px`;
  card.style.transition = "opacity 500ms ease, max-height 500ms ease, margin 500ms ease, padding 500ms ease";

  requestAnimationFrame(() => {
    card.style.opacity = "0";
    card.style.maxHeight = "0px";
    card.style.marginTop = "0";
    card.style.marginBottom = "0";
    card.style.paddingTop = "0";
    card.style.paddingBottom = "0";
  });

  card.addEventListener("transitionend", () => {
    if (dismissButton && dismissButton.isConnected) {
      dismissButton.click();
    }
    card.dataset.easyApplyDismissState = "done";
    card.style.display = "none";

  }, { once: true });
}

function buildContextSignature(context) {
  return [
    cleanText(context?.jobKey),
    cleanText(context?.title),
    cleanText(context?.company),
    cleanText(context?.postedAtText),
    cleanText(context?.url),
    cleanText(context?.description).slice(0, 200)
  ].join("|");
}

function extractLinkedInJobKeyFromUrl(url) {
  const source = String(url || "");
  const match = source.match(/\/jobs\/view\/(\d+)/i);
  return match?.[1] || "";
}

function getSelectedLinkedInJobKey() {
  const selectedCard = firstElement([
    ".jobs-search-results__list-item--active",
    ".jobs-search-results-list__list-item--active",
    ".job-card-container--clickable[aria-current='true']",
    ".jobs-search-results__list-item[aria-current='true']"
  ]);

  const selectedHref = selectedCard?.querySelector("a[href*='/jobs/view/']")?.href || "";
  const selectedFromCard = extractLinkedInJobKeyFromUrl(selectedHref);
  if (selectedFromCard) {
    return selectedFromCard;
  }

  const detailRoot = firstElement([
    ".jobs-search__job-details--container",
    ".jobs-details",
    ".job-view-layout"
  ]);
  const detailHref = detailRoot
    ? firstElement([
        ".jobs-unified-top-card__content a[href*='/jobs/view/']",
        ".job-details-jobs-unified-top-card__job-title a[href*='/jobs/view/']",
        ".jobs-unified-top-card__job-title a[href*='/jobs/view/']"
      ], detailRoot)?.href || ""
    : "";

  const selectedFromDetail = extractLinkedInJobKeyFromUrl(detailHref);
  if (selectedFromDetail) {
    return selectedFromDetail;
  }

  return extractLinkedInJobKeyFromUrl(location.href);
}

function extractLinkedInCardContext(card) {
  const title = textFromSelectors(
    [
      ".job-card-list__title",
      ".job-card-container__link",
      ".artdeco-entity-lockup__title a",
      "a[href*='/jobs/view/']"
    ],
    card
  );

  const company = textFromSelectors(
    [
      ".job-card-container__company-name",
      ".artdeco-entity-lockup__subtitle",
      ".job-card-container__primary-description"
    ],
    card
  );

  const description = textFromSelectors(
    [
      ".job-card-list__description",
      ".job-card-container__footer-item",
      ".artdeco-entity-lockup__caption",
      ".job-card-list__insight"
    ],
    card
  );

  const postedAtText = textFromSelectors(["time", ".job-card-container__listed-time", ".job-card-list__footer-wrapper"], card);
  const link = card.querySelector("a[href*='/jobs/view/']")?.href || "";
  const jobKey = extractLinkedInJobKeyFromUrl(link) || cleanText(link);
  const ghostAssessment = assessGhostRisk({ title, company, description, postedAtText });

  return {
    source: "linkedin",
    jobKey,
    title,
    company,
    description,
    postedAtText,
    ghostAssessment,
    hasEasyApply: false,
    url: link
  };
}

function runLinkedInListStaticScan() {
  const cards = listCardElements();

  for (const card of cards) {
    try {
    if (card.dataset.easyApplyDismissState === "running") {
      continue;
    }

    const context = extractLinkedInCardContext(card);
    const signature = buildContextSignature(context);

    if (card.dataset.easyApplyScamSig === signature) {
      continue;
    }

    const scam = assessScamSignals(context);
    recordStaticAssessmentTelemetry(signature, context, scam, "list");

    if (isAlreadyAppliedCard(card, context)) {
      animateAndDismissAppliedCard(card);
      card.dataset.easyApplyScamSig = signature;
      continue;
    }

    if (scam.decision?.action === "dismiss") {
      animateAndDismissFlaggedCard(card, buildHardAvoidReason(scam));
      card.dataset.easyApplyScamSig = signature;
      continue;
    }

    const shouldCover = Boolean(scam.decision?.action === "cover");
    const reason = buildHardAvoidReason(scam);
    setCoveredState(card, shouldCover, `Avoided: ${reason}`);
    card.dataset.easyApplyScamSig = signature;
    } catch {
      // Ignore per-card errors so one malformed card does not break the whole scan.
    }
  }
}

function runLinkedInPreviewStaticScan() {
  try {
  const previewRoot = firstElement([
    ".jobs-search__job-details--container",
    ".jobs-details",
    ".job-view-layout"
  ]);

  if (!previewRoot) {
    return;
  }

  const context = extractLinkedInContext();
  const signature = buildContextSignature(context);

  if (previewRoot.dataset.easyApplyScamSig === signature) {
    return;
  }

  const scam = assessScamSignals(context);
  recordStaticAssessmentTelemetry(signature, context, scam, "preview");
  const shouldCover = Boolean(scam.decision?.action === "cover" || scam.decision?.action === "dismiss");
  const reason = buildHardAvoidReason(scam);
  setCoveredState(previewRoot, shouldCover, `Avoided: ${reason}`);
  previewRoot.dataset.easyApplyScamSig = signature;
  } catch {
    // Keep scanner alive if preview extraction temporarily fails during LinkedIn rerenders.
  }
}

function runLinkedInScamCoverPass() {
  if (!location.hostname.includes("linkedin.com")) {
    return;
  }

  runLinkedInListStaticScan();
  runLinkedInPreviewStaticScan();
  updateLinkedInListStats();
}

function findByText(selectors, matcher) {
  const elements = Array.from(document.querySelectorAll(selectors));
  return elements.find((element) => matcher(cleanText(element.textContent || "")));
}

function normalizeQuestion(label) {
  return cleanText(label).toLowerCase();
}

function pickAnswer(question, answersMap) {
  const normalized = normalizeQuestion(question);

  for (const [theme, answer] of Object.entries(answersMap || {})) {
    if (normalized.includes(theme.toLowerCase())) {
      return String(answer);
    }
  }

  return "";
}

function setInputValue(input, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    "value"
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function tryAttachResume({ resumePdfBase64, resumePdfMime, resumePdfName }) {
  const upload = document.querySelector('input[type="file"]');
  if (!upload) {
    return false;
  }

  const byteChars = atob(resumePdfBase64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i += 1) {
    bytes[i] = byteChars.charCodeAt(i);
  }

  const file = new File([bytes], resumePdfName || "resume.pdf", { type: resumePdfMime || "application/pdf" });
  const dt = new DataTransfer();
  dt.items.add(file);

  upload.files = dt.files;
  upload.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function fillKnownFields(applicationAnswers) {
  let fieldsFilled = 0;

  const fields = Array.from(
    document.querySelectorAll("input[type='text'], input[type='email'], input[type='tel'], textarea")
  );

  for (const field of fields) {
    if (field.disabled || field.readOnly || cleanText(field.value)) {
      continue;
    }

    let question = "";

    if (field.id) {
      const label = document.querySelector(`label[for='${CSS.escape(field.id)}']`);
      if (label) {
        question = cleanText(label.textContent);
      }
    }

    if (!question) {
      const nearbyLabel = field.closest("label");
      if (nearbyLabel) {
        question = cleanText(nearbyLabel.textContent);
      }
    }

    if (!question) {
      question = cleanText(field.getAttribute("aria-label") || field.getAttribute("name") || "");
    }

    const answer = pickAnswer(question, applicationAnswers);
    if (!answer) {
      continue;
    }

    setInputValue(field, answer);
    fieldsFilled += 1;
  }

  return fieldsFilled;
}

function maybeUnfollowStayUpToDate() {
  let uncheckedCount = 0;
  const candidates = Array.from(document.querySelectorAll("input[type='checkbox']"));

  for (const checkbox of candidates) {
    if (!checkbox.checked || checkbox.disabled) {
      continue;
    }

    const labelFromFor = checkbox.id
      ? document.querySelector(`label[for='${CSS.escape(checkbox.id)}']`)
      : null;
    const labelText = cleanText(
      [
        labelFromFor?.textContent,
        checkbox.closest("label")?.textContent,
        checkbox.getAttribute("aria-label"),
        checkbox.getAttribute("name")
      ].filter(Boolean).join(" ")
    ).toLowerCase();

    const isFollowToggle = [
      "stay up to date",
      "job updates",
      "follow",
      "company updates",
      "update emails"
    ].some((needle) => labelText.includes(needle));

    if (!isFollowToggle) {
      continue;
    }

    checkbox.click();
    uncheckedCount += 1;
  }

  return uncheckedCount;
}

function clickProgressButtons({ allowAutoSubmit }) {
  const progressMatchers = ["next", "continue", "review", "submit application", "apply", "send"]; 
  let buttonsClicked = 0;

  for (const matcher of progressMatchers) {
    const button = findByText("button, [role='button']", (text) => text.toLowerCase() === matcher);
    if (!button) {
      continue;
    }

    const normalized = matcher.toLowerCase();
    const isFinalSubmit = normalized.includes("submit") || normalized.includes("send");
    if (isFinalSubmit && !allowAutoSubmit) {
      continue;
    }

    button.click();
    buttonsClicked += 1;
  }

  return buttonsClicked;
}

function extractLinkedInContext() {
  const postingRoot =
    firstElement([
      ".jobs-search__job-details--container",
      ".jobs-details",
      ".jobs-unified-top-card"
    ]) || document;

  const title = textFromSelectors(
    [
      ".job-details-jobs-unified-top-card__job-title",
      ".jobs-unified-top-card__job-title",
      "h1"
    ],
    postingRoot
  );

  const company = textFromSelectors(
    [
      ".job-details-jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__company-name",
      ".topcard__org-name-link"
    ],
    postingRoot
  );

  const description = textFromSelectors(
    [
      ".jobs-description-content__text",
      ".jobs-box__html-content",
      "[data-job-id] .jobs-description",
      ".jobs-description"
    ],
    postingRoot
  ).slice(0, 12000);

  const postedAtText = textFromSelectors(
    [
      ".jobs-unified-top-card__subtitle-primary-grouping span",
      ".job-details-jobs-unified-top-card__primary-description-container span",
      "time"
    ],
    postingRoot
  );

  const hasEasyApply = Boolean(findByText("button, [role='button']", (text) => text.toLowerCase().includes("easy apply")));
  const ghostAssessment = assessGhostRisk({ title, company, description, postedAtText });
  const url = location.href;
  const jobKey =
    getSelectedLinkedInJobKey() ||
    extractLinkedInJobKeyFromUrl(url) ||
    cleanText(title).toLowerCase().slice(0, 64);

  return {
    source: "linkedin",
    jobKey,
    title,
    company,
    description,
    postedAtText,
    ghostAssessment,
    hasEasyApply,
    url
  };
}

function extractIndeedContext() {
  const postingRoot =
    firstElement([
      "#mosaic-jobResults",
      "#jobsearch-ViewjobPaneWrapper",
      "#viewJobSSRRoot"
    ]) || document;

  const title = textFromSelectors(["h1", "[data-testid='jobsearch-JobInfoHeader-title']"], postingRoot);
  const company = textFromSelectors(
    [
      "[data-testid='inlineHeader-companyName']",
      ".jobsearch-InlineCompanyRating",
      "[data-testid='viewJobCompanyName']"
    ],
    postingRoot
  );
  const description = textFromSelectors(["#jobDescriptionText", "[data-testid='jobsearch-JobComponent-description']"], postingRoot).slice(0, 12000);

  const postedAtText = textFromSelectors(
    [
      "[data-testid='jobsearch-JobMetadataFooter']",
      "[data-testid='jobsearch-JobInfoHeader-subtitle']",
      "time"
    ],
    postingRoot
  );

  const ghostAssessment = assessGhostRisk({ title, company, description, postedAtText });

  return {
    source: "indeed",
    title,
    company,
    description,
    postedAtText,
    ghostAssessment,
    hasEasyApply: true,
    url: location.href
  };
}

function buildReviewWidgetHtml() {
  return `
    <div class="artdeco-card" style="border:1px solid #d5deea;border-radius:12px;padding:12px;background:#f8fbff;margin:12px 0;font-family:inherit;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div style="font-weight:700;font-size:14px;color:#0a66c2;">Easy Apply Copilot</div>
      </div>
      <div id="easyApplyCopilotResumePanel" style="margin-top:10px;padding:10px;border:1px solid #dce6f1;border-radius:10px;background:#ffffff;">
        <div style="font-size:12px;font-weight:700;color:#334155;margin-bottom:8px;">Tailored Resume Panel</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="easyApplyCopilotAnalyzeBtn" class="artdeco-button artdeco-button--2 artdeco-button--secondary" style="cursor:pointer;font-weight:600;">Analyze Job</button>
          <button id="easyApplyCopilotGenerateBtn" class="artdeco-button artdeco-button--2 artdeco-button--primary" style="cursor:pointer;font-weight:600;" disabled>Generate Tailored Resume</button>
        </div>
        <div style="margin-top:6px;font-size:12px;color:#5b6673;">Generate is enabled only after analysis for the active posting.</div>
      </div>
      <div id="easyApplyCopilotStaticBody" style="margin-top:10px;font-size:13px;white-space:pre-wrap;color:#1f2328;border-top:1px solid #dce6f1;padding-top:10px;"></div>
      <div id="easyApplyCopilotReviewBody" style="margin-top:10px;font-size:13px;white-space:pre-wrap;color:#1f2328;"></div>
    </div>
  `;
}

function setResumePanelState(wrapper, { analyzeBusy = false, generateBusy = false, canGenerate = false } = {}) {
  if (!wrapper || !wrapper.isConnected) {
    return;
  }

  const analyzeBtn = wrapper.querySelector("#easyApplyCopilotAnalyzeBtn");
  const generateBtn = wrapper.querySelector("#easyApplyCopilotGenerateBtn");

  if (analyzeBtn) {
    analyzeBtn.disabled = analyzeBusy || generateBusy;
    analyzeBtn.textContent = analyzeBusy ? "Analyzing..." : "Analyze Job";
  }

  if (generateBtn) {
    generateBtn.disabled = analyzeBusy || generateBusy || !canGenerate;
    generateBtn.textContent = generateBusy ? "Generating..." : "Generate Tailored Resume";
  }
}

function renderReviewBody(container, lines, isError = false) {
  container.textContent = lines.join("\n");
  container.style.color = isError ? "#8f1d1d" : "#1f2328";
}

const riskStrings = {
  ghostJob: "Ghost Job",
  scamRisk: "Scam Risk",
  aiDrivenProduct: "AI-Driven Product",
  aiTrainingData: "AI Training Data",
  automatedAiInterviewingStep: "Automated/AI Interviewing",
  candidateQualificationTask: "Candidate Qualification Task",
  timedCandidateTaskUnder60: "Timed Candidate Task <= 60m",
  candidateQualificationFreeTask: "Candidate Qualification or Free Task",
  aiDomainFound: "AI Domain Found",
  knownCompanyFlag: "Known Company Flag",
  referralHarvesting: "Referral Harvesting",
  externalInterviewRedirect: "External Interview Redirect",
  impossibleRole: "Impossible Role Pattern",
  highCompOutlier: "Compensation Outlier"
}

function buildRisksSummary(signals) {
  if (!buildRisksSummary.element?.isConnected) {
    const div = document.createElement("div");
    div.id = "easyApplyCopilotRisksSummary";
    div.style.display = "flex";
    div.style.flexWrap = "wrap";
    div.style.gap = "4px";
    div.style.marginTop = "8px";
    div.style.padding = "16px 24px";
    div.style.background = "#fff1f0";
    div.style.border = "1px solid #f5c2c7";
    div.style.borderRadius = "8px";
  
    buildRisksSummary.element = div;
  }

  const div = buildRisksSummary.element;
  div.textContent = "";

  for (const [signal, active] of Object.entries(signals)) {
    if (active === false) continue

    const signalDiv = document.createElement("div");
    signalDiv.textContent = riskStrings[signal] || signal;
    signalDiv.style.background = "#f5c2c7";
    signalDiv.style.color = "#8f1d1d";
    signalDiv.style.padding = "4px 8px";
    signalDiv.style.borderRadius = "4px";
    signalDiv.style.fontSize = "12px";
    signalDiv.style.fontWeight = "600";

    div.appendChild(signalDiv);
  }

  if (div.children.length === 0) {
    div.style.background = "transparent";
    div.style.border = "1px solid #eaeaea";

    const noRiskDiv = document.createElement("div");
    noRiskDiv.textContent = "No risks in the description";
    noRiskDiv.style.color = "#444";
    noRiskDiv.style.fontSize = "12px";
    noRiskDiv.style.fontWeight = "600";
    div.appendChild(noRiskDiv);
  } else {
    div.style.background = "#fff1f0";
    div.style.border = "1px solid #f5c2c7";
  }

  return div;
}

async function runLinkedInInlineReview(wrapper, bodyEl) {
  setResumePanelState(wrapper, { analyzeBusy: true, canGenerate: false });

  try {
    const jobContext = extractLinkedInContext();
    const signature = buildContextSignature(jobContext);
    const cachedReview = linkedInReviewCache.llmBySignature.get(signature);

    if (cachedReview?.lines?.length) {
      renderReviewBody(bodyEl, cachedReview.lines, Boolean(cachedReview.isError));
      if (!cachedReview.isError) {
        linkedInReviewCache.analyzedBySignature.add(signature);
      }
      setResumePanelState(wrapper, {
        canGenerate: linkedInReviewCache.analyzedBySignature.has(signature)
      });
      return;
    }

    if (!jobContext.title || !jobContext.description) {
      throw new Error("Open a full LinkedIn job details view first.");
    }

    if (jobContext.ghostAssessment?.shouldAvoid) {
      const reasons = (jobContext.ghostAssessment.signals || []).map((item) => `- ${item}`);
      renderReviewBody(
        bodyEl,
        [
          "Potential ghost posting detected. Skipping deep review.",
          `Risk score: ${jobContext.ghostAssessment.riskScore}/100`,
          "",
          "Signals:",
          ...(reasons.length ? reasons : ["- Posting quality appears low."])
        ],
        true
      );

      linkedInReviewCache.llmBySignature.set(signature, {
        lines: bodyEl.textContent.split("\n"),
        isError: true
      });
      setResumePanelState(wrapper, { canGenerate: false });
      return;
    }

    renderReviewBody(bodyEl, ["Analyzing fit... this usually takes a few seconds."]);

    const existingRequest = linkedInReviewCache.pendingBySignature.get(signature);
    const createdRequest = !existingRequest;
    const requestPromise = existingRequest || chrome.runtime.sendMessage({
      type: "analyze-job-fit",
      jobContext
    });

    if (createdRequest) {
      linkedInReviewCache.pendingBySignature.set(signature, requestPromise);
    }

    let resolved;
    try {
      resolved = await requestPromise;
    } finally {
      if (createdRequest) {
        linkedInReviewCache.pendingBySignature.delete(signature);
      }
    }

    if (!resolved?.ok) {
      throw new Error(resolved?.error || "Analysis failed.");
    }

    const lines = [
      `Fit score: ${resolved.data.fitScore}/100`,
      "",
      "Why this role:",
      resolved.data.reasoning || "No reasoning provided.",
      "",
      `Must-have match: ${resolved.data.mustHaveMatch || "Unknown"}`,
      `Nice-to-have match: ${resolved.data.niceToHaveMatch || "Unknown"}`,
      "",
      "Tailored resume draft is ready in the extension popup."
    ];

    linkedInReviewCache.llmBySignature.set(signature, {
      lines,
      isError: false
    });
    linkedInReviewCache.analyzedBySignature.add(signature);

    if (bodyEl.closest(`#${REVIEW_WIDGET_ID}`)?.dataset.easyApplyReviewSig === signature) {
      renderReviewBody(bodyEl, lines);
    }
    setResumePanelState(wrapper, { canGenerate: true });
  } catch (error) {
    renderReviewBody(bodyEl, [`Review failed: ${error.message}`], true);
  } finally {
    const currentSignature = wrapper?.dataset?.easyApplyReviewSig || "";
    setResumePanelState(wrapper, {
      canGenerate: Boolean(currentSignature && linkedInReviewCache.analyzedBySignature.has(currentSignature))
    });
  }
}

async function runLinkedInGenerateResume(wrapper, bodyEl) {
  const signature = wrapper?.dataset?.easyApplyReviewSig || "";
  const canGenerate = Boolean(signature && linkedInReviewCache.analyzedBySignature.has(signature));

  if (!canGenerate) {
    renderReviewBody(bodyEl, ["Analyze this job first, then generate a tailored resume."], true);
    return;
  }

  setResumePanelState(wrapper, { generateBusy: true, canGenerate: true });

  try {
    const result = await chrome.runtime.sendMessage({ type: "generate-resume-pdf" });
    if (!result?.ok) {
      throw new Error(result?.error || "Resume generation failed.");
    }

    renderReviewBody(bodyEl, [
      "Tailored resume generated for this analyzed post.",
      `File name: ${result.data.fileName}`,
      "",
      "Use Assist Easy Apply Form to attach and fill the application."
    ]);
  } catch (error) {
    renderReviewBody(bodyEl, [`Generate failed: ${error.message}`], true);
  } finally {
    setResumePanelState(wrapper, { canGenerate: true });
  }
}

function syncLinkedInReviewWidgetState(wrapper) {
  if (!wrapper || !wrapper.isConnected) {
    return;
  }

  const staticBody = wrapper.querySelector("#easyApplyCopilotStaticBody");
  const reviewBody = wrapper.querySelector("#easyApplyCopilotReviewBody");
  if (!staticBody || !reviewBody) {
    return;
  }

  let context;
  try {
    context = extractLinkedInContext();
  } catch {
    return;
  }

  const signature = buildContextSignature(context);
  const previousSignature = wrapper.dataset.easyApplyReviewSig || "";
  if (previousSignature === signature) {
    setResumePanelState(wrapper, {
      canGenerate: linkedInReviewCache.analyzedBySignature.has(signature)
    });
    return;
  }

  wrapper.dataset.easyApplyReviewSig = signature;

  wrapper.appendChild(buildRisksSummary(assessScamSignals(context).signals));

  const cachedReview = linkedInReviewCache.llmBySignature.get(signature);
  if (cachedReview?.lines?.length) {
    renderReviewBody(reviewBody, cachedReview.lines, Boolean(cachedReview.isError));
    if (!cachedReview.isError) {
      linkedInReviewCache.analyzedBySignature.add(signature);
    }
  }

  setResumePanelState(wrapper, {
    canGenerate: linkedInReviewCache.analyzedBySignature.has(signature)
  });
}

function injectLinkedInReviewWidget() {
  if (!location.hostname.includes("linkedin.com")) {
    return;
  }

  const hostContainer = firstElement([
    ".jobs-search__job-details--container",
    ".jobs-details",
    ".job-view-layout"
  ]);

  if (!hostContainer) {
    return;
  }

  if (document.getElementById(REVIEW_WIDGET_ID)) {
    return;
  }

  const anchor = firstElement([
    ".jobs-unified-top-card",
    ".job-details-jobs-unified-top-card__container--two-pane",
    ".jobs-box--fadein"
  ], hostContainer);

  const wrapper = document.createElement("section");
  wrapper.id = REVIEW_WIDGET_ID;
  wrapper.innerHTML = buildReviewWidgetHtml();

  if (anchor && anchor.parentElement) {
    anchor.parentElement.insertBefore(wrapper, anchor.nextSibling);
  } else {
    hostContainer.prepend(wrapper);
  }

  const analyzeBtn = wrapper.querySelector("#easyApplyCopilotAnalyzeBtn");
  const generateBtn = wrapper.querySelector("#easyApplyCopilotGenerateBtn");
  const staticBody = wrapper.querySelector("#easyApplyCopilotStaticBody");
  const reviewBody = wrapper.querySelector("#easyApplyCopilotReviewBody");

  if (staticBody) {
    const context = extractLinkedInContext();
    const scam = assessScamSignals(context);

    staticBody.appendChild(buildRisksSummary(scam.signals));
  }

  if (analyzeBtn && reviewBody) {
    analyzeBtn.addEventListener("click", () => runLinkedInInlineReview(wrapper, reviewBody));
  }

  if (generateBtn && reviewBody) {
    generateBtn.addEventListener("click", () => runLinkedInGenerateResume(wrapper, reviewBody));
  }

  syncLinkedInReviewWidgetState(wrapper);
}

function initInlineReviewWidget() {
  if (!location.hostname.includes("linkedin.com")) {
    return;
  }

  injectLinkedInReviewWidget();
  runLinkedInScamCoverPass();

  let timer = null;
  const observer = new MutationObserver(() => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      let wrapper = document.getElementById(REVIEW_WIDGET_ID);
      if (!wrapper) {
        injectLinkedInReviewWidget();
        wrapper = document.getElementById(REVIEW_WIDGET_ID);
      }
      syncLinkedInReviewWidgetState(wrapper);
      runLinkedInScamCoverPass();
    }, 250);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    if (message.type === "extract-job-context") {
      const host = location.hostname;
      let data;

      if (host.includes("linkedin.com")) {
        data = extractLinkedInContext();
      } else if (host.includes("indeed.com")) {
        data = extractIndeedContext();
      } else {
        throw new Error("Unsupported site. Open a supported job page first.");
      }

      if (!data.title || !data.description) {
        throw new Error("Could not extract posting-specific details. Open the job details panel and try again.");
      }

      sendResponse({ ok: true, data });
      return;
    }

    if (message.type === "assist-application") {
      const assistOptions = {
        unfollowStayUpToDate: true,
        submitForm: Boolean(message.data.allowAutoSubmit),
        autofillUnfilledFields: true,
        tailorResume: true,
        ...(message.data.assistOptions || {})
      };

      const attachedResume = tryAttachResume(message.data);
      const stayUpToDateUnchecked = assistOptions.unfollowStayUpToDate ? maybeUnfollowStayUpToDate() : 0;
      const fieldsFilled = assistOptions.autofillUnfilledFields
        ? fillKnownFields(message.data.applicationAnswers || {})
        : 0;
      const buttonsClicked = clickProgressButtons({ allowAutoSubmit: Boolean(assistOptions.submitForm) });

      sendResponse({
        ok: true,
        data: { attachedResume, fieldsFilled, buttonsClicked, stayUpToDateUnchecked }
      });
      return;
    }

    sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }

  return true;
});

initInlineReviewWidget();
