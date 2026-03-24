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
  grift: 20,
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
    "genai",
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
    "ai platform",
    "agentic ai"
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

  const griftHints = [
    "gambling",
    "crypto",
    "nft",
    "blockchain",
    "web3"
  ];

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

  const knownQuestionableCompanies = [
    "mercor", 
    "micro1", 
    "crossing hurdles",
    "g2 recruitment",
    "vivid resourcing",
    "enzo tech group",
    "asugo",
    "cingalium",
    "onesource consulting",
    "apollo solutions",
    "interex",
    "ec1 partners",
    "syndi app",
  ];

  const domainAi = domains.some((domain) => domain.endsWith(".ai"));
  const knownCompanyMention = includesAny(merged, knownQuestionableCompanies) || ["talent", "ngage"].some((needle) => company.toLowerCase() === needle);
  const griftSignal = includesAny(merged, griftHints);
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
    "ai to match",
    "ai recruit",
    "ai recruiter",
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
    grift: griftSignal,
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
  if (scam.signals.grift) {
    reasons.push("grift signal");
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
    "button svg use[href*='close']",
  ];

  for (const selector of selectors) {
    const button = card.querySelector(selector);
    if (button) {
      return button.parentElement.parentElement;
    }
  }

  return null
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

function isDismissed(card, context) {
  const selectors = [
    ".job-card-container__footer-job-state",
    ".job-card-container__applied-text",
    ".job-card-list__footer-wrapper",
    ".artdeco-entity-lockup__caption",
    ".job-card-container__footer-item--highlighted"
  ];

  const selectorText = selectors
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
    "show you this job again",
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
  overlay.textContent = "Auto-dismissing job";
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
  card.remove()
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

    if (isAlreadyAppliedCard(card, context) || isDismissed(card, context)) {
      animateAndDismissAppliedCard(card);
      continue;
    }

    const scam = assessScamSignals(context);
    recordStaticAssessmentTelemetry(signature, context, scam, "list");

    if (scam.decision?.action === "dismiss") {
      animateAndDismissFlaggedCard(card, buildHardAvoidReason(scam));
      card.dataset.easyApplyScamSig = signature;
      continue;
    }
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
  recordStaticAssessmentTelemetry(signature, context, scam, "preview")
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
  highCompOutlier: "Compensation Outlier",
  grift: "Grift (Gambling/Blockchain)",
}

const skillMatchers = [
  { label: ".NET", patterns: [/\b\.net\b/i, /\bdotnet\b/i] },
  { label: "C#", patterns: [/\bc#\b/i, /\bcsharp\b/i] },
  { label: "C++", patterns: [/\bc\+\+\b/i] },
  { label: "C", patterns: [/\bc language\b/i, /\bansi c\b/i] },
  { label: "TypeScript (TS)", patterns: [/\btypescript\b/i, /\bts\b/i] },
  { label: "JavaScript", patterns: [/\bjavascript\b/i, /\bjs\b/i] },
  { label: "ECMAScript", patterns: [/\becmascript\b/i] },
  { label: "Node.js", patterns: [/\bnode\.js\b/i, /\bnodejs\b/i] },
  { label: "Deno", patterns: [/\bdeno\b/i] },
  { label: "Bun", patterns: [/\bbun\b/i] },
  { label: "React", patterns: [/\breact\b/i] },
  { label: "React Native", patterns: [/\breact native\b/i] },
  { label: "Next.js", patterns: [/\bnext\.js\b/i, /\bnextjs\b/i] },
  { label: "Redux", patterns: [/\bredux\b/i] },
  { label: "Angular", patterns: [/\bangular\b/i] },
  { label: "Vue", patterns: [/\bvue\b/i] },
  { label: "Nuxt", patterns: [/\bnuxt\b/i] },
  { label: "Svelte", patterns: [/\bsvelte\b/i] },
  { label: "SvelteKit", patterns: [/\bsveltekit\b/i] },
  { label: "Tailwind CSS", patterns: [/\btailwind\b/i] },
  { label: "CSS", patterns: [/\bcss\b/i, /\bscss\b/i, /\bsass\b/i, /\bless\b/i] },
  { label: "HTML", patterns: [/\bhtml\b/i] },
  { label: "Webpack", patterns: [/\bwebpack\b/i] },
  { label: "Vite", patterns: [/\bvite\b/i] },
  { label: "Babel", patterns: [/\bbabel\b/i] },
  { label: "jQuery", patterns: [/\bjquery\b/i] },
  { label: "Python", patterns: [/\bpython\b/i] },
  { label: "Django", patterns: [/\bdjango\b/i] },
  { label: "Flask", patterns: [/\bflask\b/i] },
  { label: "FastAPI", patterns: [/\bfastapi\b/i] },
  { label: "Pandas", patterns: [/\bpandas\b/i] },
  { label: "NumPy", patterns: [/\bnumpy\b/i] },
  { label: "PyTorch", patterns: [/\bpytorch\b/i] },
  { label: "TensorFlow", patterns: [/\btensorflow\b/i] },
  { label: "Java", patterns: [/\bjava\b/i] },
  { label: "Spring", patterns: [/\bspring\b/i, /\bspring boot\b/i] },
  { label: "Kotlin", patterns: [/\bkotlin\b/i] },
  { label: "Scala", patterns: [/\bscala\b/i] },
  { label: "Go", patterns: [/\bgolang\b/i, /\bgo\b/i] },
  { label: "Rust", patterns: [/\brust\b/i] },
  { label: "PHP", patterns: [/\bphp\b/i] },
  { label: "Laravel", patterns: [/\blaravel\b/i] },
  { label: "Ruby", patterns: [/\bruby\b/i] },
  { label: "Ruby on Rails", patterns: [/\brails\b/i, /\bruby on rails\b/i] },
  { label: "Swift", patterns: [/\bswift\b/i] },
  { label: "Objective-C", patterns: [/\bobjective-c\b/i, /\bobjc\b/i] },
  { label: "Dart", patterns: [/\bdart\b/i] },
  { label: "Flutter", patterns: [/\bflutter\b/i] },
  { label: "Android", patterns: [/\bandroid\b/i] },
  { label: "iOS", patterns: [/\bios\b/i] },
  { label: "Shell/Bash", patterns: [/\bbash\b/i, /\bshell scripting\b/i] },
  { label: "PowerShell", patterns: [/\bpowershell\b/i] },
  { label: "SQL", patterns: [/\bsql\b/i, /\bpostgres\b/i, /\bmysql\b/i] },
  { label: "PostgreSQL", patterns: [/\bpostgresql\b/i, /\bpostgres\b/i] },
  { label: "MySQL", patterns: [/\bmysql\b/i] },
  { label: "SQL Server", patterns: [/\bsql server\b/i, /\bmssql\b/i] },
  { label: "Oracle", patterns: [/\boracle\b/i] },
  { label: "SQLite", patterns: [/\bsqlite\b/i] },
  { label: "MongoDB", patterns: [/\bmongodb\b/i, /\bmongo\b/i] },
  { label: "Redis", patterns: [/\bredis\b/i] },
  { label: "Elasticsearch", patterns: [/\belasticsearch\b/i, /\belk\b/i] },
  { label: "Snowflake", patterns: [/\bsnowflake\b/i] },
  { label: "BigQuery", patterns: [/\bbigquery\b/i] },
  { label: "Databricks", patterns: [/\bdatabricks\b/i] },
  { label: "Apache Spark", patterns: [/\bspark\b/i, /\bapache spark\b/i] },
  { label: "Hadoop", patterns: [/\bhadoop\b/i] },
  { label: "Kafka", patterns: [/\bkafka\b/i] },
  { label: "RabbitMQ", patterns: [/\brabbitmq\b/i] },
  { label: "Airflow", patterns: [/\bairflow\b/i] },
  { label: "AWS", patterns: [/\baws\b/i, /\bamazon web services\b/i] },
  { label: "AWS Lambda", patterns: [/\blambda\b/i] },
  { label: "AWS ECS", patterns: [/\becs\b/i] },
  { label: "AWS EKS", patterns: [/\beks\b/i] },
  { label: "AWS S3", patterns: [/\bs3\b/i] },
  { label: "AWS RDS", patterns: [/\brds\b/i] },
  { label: "Azure", patterns: [/\bazure\b/i] },
  { label: "Azure DevOps", patterns: [/\bazure devops\b/i] },
  { label: "AKS", patterns: [/\baks\b/i] },
  { label: "GCP", patterns: [/\bgcp\b/i, /\bgoogle cloud\b/i] },
  { label: "CloudFormation", patterns: [/\bcloudformation\b/i] },
  { label: "Terraform", patterns: [/\bterraform\b/i] },
  { label: "Ansible", patterns: [/\bansible\b/i] },
  { label: "Linux", patterns: [/\blinux\b/i] },
  { label: "Docker", patterns: [/\bdocker\b/i] },
  { label: "Kubernetes", patterns: [/\bkubernetes\b/i, /\bk8s\b/i] },
  { label: "Helm", patterns: [/\bhelm\b/i] },
  { label: "CI/CD", patterns: [/\bci\/cd\b/i, /\bcontinuous integration\b/i, /\bcontinuous delivery\b/i, /\bcontinuous deployment\b/i] },
  { label: "GitHub Actions", patterns: [/\bgithub actions\b/i] },
  { label: "GitLab CI", patterns: [/\bgitlab ci\b/i] },
  { label: "Jenkins", patterns: [/\bjenkins\b/i] },
  { label: "ArgoCD", patterns: [/\bargocd\b/i] },
  { label: "Microservices", patterns: [/\bmicroservices\b/i, /\bservice-oriented architecture\b/i] },
  { label: "GraphQL", patterns: [/\bgraphql\b/i] },
  { label: "REST API", patterns: [/\brest\b/i, /\brestful\b/i, /\brest api\b/i] },
  { label: "gRPC", patterns: [/\bgrpc\b/i] },
  { label: "WebSockets", patterns: [/\bwebsocket\b/i, /\bwebsockets\b/i] },
  { label: "OpenAPI/Swagger", patterns: [/\bopenapi\b/i, /\bswagger\b/i] },
  { label: "Testing", patterns: [/\bunit test\b/i, /\bintegration test\b/i, /\be2e\b/i, /\btest automation\b/i] },
  { label: "Jest", patterns: [/\bjest\b/i] },
  { label: "Cypress", patterns: [/\bcypress\b/i] },
  { label: "Playwright", patterns: [/\bplaywright\b/i] },
  { label: "Selenium", patterns: [/\bselenium\b/i] },
  { label: "Pytest", patterns: [/\bpytest\b/i] },
  { label: "JUnit", patterns: [/\bjunit\b/i] },
  { label: "NUnit", patterns: [/\bnunit\b/i] },
  { label: "xUnit", patterns: [/\bxunit\b/i] },
  { label: "TDD", patterns: [/\btdd\b/i, /\btest-driven development\b/i] },
  { label: "BDD", patterns: [/\bbdd\b/i, /\bbehavior[- ]driven\b/i] },
  { label: "Agile", patterns: [/\bagile\b/i, /\bscrum\b/i, /\bkanban\b/i] },
  { label: "System Design", patterns: [/\bsystem design\b/i, /\bdistributed systems\b/i] },
  { label: "Architecture", patterns: [/\bsoftware architecture\b/i, /\bsolution architecture\b/i] },
  { label: "Security", patterns: [/\bapplication security\b/i, /\bsecure coding\b/i, /\bowasp\b/i] },
  { label: "OAuth/JWT", patterns: [/\boauth\b/i, /\bopenid\b/i, /\bjwt\b/i] },
  { label: "SAML/SSO", patterns: [/\bsaml\b/i, /\bsso\b/i, /\bsingle sign-on\b/i] },
  { label: "Observability", patterns: [/\bobservability\b/i, /\blogging\b/i, /\bmetrics\b/i, /\btracing\b/i] },
  { label: "Prometheus", patterns: [/\bprometheus\b/i] },
  { label: "Grafana", patterns: [/\bgrafana\b/i] },
  { label: "Datadog", patterns: [/\bdatadog\b/i] },
  { label: "Splunk", patterns: [/\bsplunk\b/i] },
  { label: "Sentry", patterns: [/\bsentry\b/i] },
  { label: "ML/AI", patterns: [/\bmachine learning\b/i, /\bartificial intelligence\b/i, /\bgenerative ai\b/i, /\bllm\b/i] },
  { label: "NLP", patterns: [/\bnlp\b/i, /\bnatural language processing\b/i] },
  { label: "Computer Vision", patterns: [/\bcomputer vision\b/i] },
  { label: "Data Science", patterns: [/\bdata science\b/i, /\bstatistical modeling\b/i] },
  { label: "MLOps", patterns: [/\bmlops\b/i] },
  { label: "ETL/ELT", patterns: [/\betl\b/i, /\belt\b/i, /\bdata pipeline\b/i] },
  { label: "Tableau", patterns: [/\btableau\b/i] },
  { label: "Power BI", patterns: [/\bpower bi\b/i] },
  { label: "Figma", patterns: [/\bfigma\b/i] },
  { label: "Product Management", patterns: [/\bproduct management\b/i, /\bproduct manager\b/i] },
  { label: "Project Management", patterns: [/\bproject management\b/i, /\bpmp\b/i] },
  { label: "Leadership", patterns: [/\bleadership\b/i, /\bmentor\b/i, /\bmentorship\b/i, /\bteam lead\b/i] },
  { label: "Communication", patterns: [/\bcommunication skills\b/i, /\bstakeholder management\b/i] }
];

const benefitMatchers = [
  { label: "Remote Work", patterns: [/\bremote\b/i, /\bwork from home\b/i, /\bwfh\b/i] },
  { label: "Hybrid Work", patterns: [/\bhybrid\b/i] },
  { label: "Onsite", patterns: [/\bonsite\b/i, /\bon-site\b/i, /\bin office\b/i] },
  { label: "Flexible Hours", patterns: [/\bflexible hours\b/i, /\bflex time\b/i, /\bflexible schedule\b/i] },
  { label: "4-Day Work Week", patterns: [/\b4-day work week\b/i, /\bfour-day work week\b/i] },
  { label: "Compressed Workweek", patterns: [/\bcompressed workweek\b/i] },
  { label: "Work From Anywhere", patterns: [/\bwork from anywhere\b/i, /\banywhere in\b/i] },
  { label: "Health Insurance", patterns: [/\bhealth insurance\b/i, /\bmedical\b/i, /\bdental\b/i, /\bvision\b/i] },
  { label: "Life Insurance", patterns: [/\blife insurance\b/i] },
  { label: "Disability Insurance", patterns: [/\bdisability insurance\b/i, /\bshort-term disability\b/i, /\blong-term disability\b/i] },
  { label: "HSA/FSA", patterns: [/\bhsa\b/i, /\bfsa\b/i, /\bhealth savings account\b/i, /\bflexible spending account\b/i] },
  { label: "401(k)", patterns: [/\b401\(k\)\b/i, /\bretirement plan\b/i] },
  { label: "Pension", patterns: [/\bpension\b/i] },
  { label: "Employer Match", patterns: [/\bemployer match\b/i, /\bcompany match\b/i] },
  { label: "Paid Time Off", patterns: [/\bpaid time off\b/i, /\bpto\b/i, /\bvacation\b/i] },
  { label: "Paid Holidays", patterns: [/\bpaid holidays\b/i, /\bpublic holidays\b/i] },
  { label: "Sick Leave", patterns: [/\bsick leave\b/i, /\bpaid sick\b/i] },
  { label: "Unlimited PTO", patterns: [/\bunlimited pto\b/i, /\bunlimited vacation\b/i] },
  { label: "Parental Leave", patterns: [/\bparental leave\b/i, /\bmaternity leave\b/i, /\bpaternity leave\b/i] },
  { label: "Family Leave", patterns: [/\bfamily leave\b/i] },
  { label: "Bereavement Leave", patterns: [/\bbereavement\b/i] },
  { label: "Volunteer Time Off", patterns: [/\bvolunteer time off\b/i, /\bvto\b/i] },
  { label: "Equity", patterns: [/\bequity\b/i, /\bstock options\b/i, /\brsu\b/i] },
  { label: "ESPP", patterns: [/\bespp\b/i, /\bemployee stock purchase\b/i] },
  { label: "Bonus", patterns: [/\bbonus\b/i, /\bperformance bonus\b/i] },
  { label: "Annual Bonus", patterns: [/\bannual bonus\b/i] },
  { label: "Signing Bonus", patterns: [/\bsigning bonus\b/i, /\bsign-on bonus\b/i] },
  { label: "Retention Bonus", patterns: [/\bretention bonus\b/i] },
  { label: "Commission", patterns: [/\bcommission\b/i, /\bote\b/i, /\bon-target earnings\b/i] },
  { label: "Profit Sharing", patterns: [/\bprofit sharing\b/i] },
  { label: "Overtime Pay", patterns: [/\bovertime pay\b/i] },
  { label: "Learning Budget", patterns: [/\blearning budget\b/i, /\btraining budget\b/i, /\beducation stipend\b/i] },
  { label: "Tuition Reimbursement", patterns: [/\btuition reimbursement\b/i, /\btuition assistance\b/i] },
  { label: "Certification Support", patterns: [/\bcertification reimbursement\b/i, /\bcertification support\b/i] },
  { label: "Conference Budget", patterns: [/\bconference budget\b/i, /\bconference stipend\b/i] },
  { label: "Career Growth", patterns: [/\bcareer growth\b/i, /\bcareer progression\b/i, /\bpromotion opportunities\b/i] },
  { label: "Mentorship", patterns: [/\bmentorship\b/i, /\bmentor program\b/i] },
  { label: "Wellness", patterns: [/\bwellness stipend\b/i, /\bmental health\b/i, /\bgym reimbursement\b/i] },
  { label: "EAP", patterns: [/\bemployee assistance program\b/i, /\beap\b/i] },
  { label: "Gym Membership", patterns: [/\bgym membership\b/i, /\bfitness stipend\b/i] },
  { label: "Free Meals/Snacks", patterns: [/\bfree meals\b/i, /\bfree snacks\b/i, /\bcatered lunch\b/i] },
  { label: "Commuter Benefits", patterns: [/\bcommuter benefits\b/i, /\btransit pass\b/i, /\bparking reimbursement\b/i] },
  { label: "Internet/Phone Stipend", patterns: [/\binternet stipend\b/i, /\bphone stipend\b/i, /\bhome office stipend\b/i] },
  { label: "Home Office Equipment", patterns: [/\bhome office equipment\b/i, /\bworkspace allowance\b/i, /\bequipment provided\b/i] },
  { label: "Company Laptop", patterns: [/\bcompany laptop\b/i, /\blaptop provided\b/i] },
  { label: "Travel Opportunities", patterns: [/\btravel opportunities\b/i, /\boccasional travel\b/i, /\bbusiness travel\b/i] },
  { label: "Team Retreats", patterns: [/\bteam retreats\b/i, /\boffsites\b/i] },
  { label: "Employee Discounts", patterns: [/\bemployee discount\b/i, /\bdiscount program\b/i] },
  { label: "Childcare Support", patterns: [/\bchildcare\b/i, /\bdaycare\b/i] },
  { label: "Adoption Assistance", patterns: [/\badoption assistance\b/i] },
  { label: "Fertility Benefits", patterns: [/\bfertility benefits\b/i, /\bfertility support\b/i] },
  { label: "Pet Insurance", patterns: [/\bpet insurance\b/i] },
  { label: "Legal Assistance", patterns: [/\blegal assistance\b/i, /\blegal plan\b/i] },
  { label: "Sabbatical", patterns: [/\bsabbatical\b/i] },
  { label: "Company Car", patterns: [/\bcompany car\b/i] },
  { label: "Paid Relocation", patterns: [/\bpaid relocation\b/i, /\brelocation package\b/i] },
  { label: "Visa Sponsorship", patterns: [/\bvisa sponsorship\b/i, /\bsponsorship available\b/i] },
  { label: "Immigration Support", patterns: [/\bimmigration support\b/i, /\bwork permit support\b/i] },
  { label: "Relocation", patterns: [/\brelocation\b/i, /\brelocation assistance\b/i] }
];

function collectMentions(text, matchers) {
  const source = String(text || "");
  const found = [];

  for (const matcher of matchers) {
    if (matcher.patterns.some((pattern) => pattern.test(source))) {
      found.push(matcher.label);
    }
  }

  return found;
}

function buildSkillsSummary(context) {
  const merged = [context?.title, context?.description, context?.company].map((item) => String(item || "")).join("\n");
  const skills = collectMentions(merged, skillMatchers);

  const section = document.createElement("div");
  section.id = "easyApplyCopilotSkillsSummary";
  section.style.marginTop = "8px";
  section.style.padding = "8px";
  section.style.background = "#ffffff";
  section.style.border = "1px solid #111111";
  section.style.borderRadius = "8px";

  const title = document.createElement("div");
  title.textContent = "Skills Mentioned";
  title.style.color = "#111111";
  title.style.fontSize = "12px";
  title.style.fontWeight = "700";
  title.style.marginBottom = "6px";
  section.appendChild(title);

  const tags = document.createElement("div");
  tags.style.display = "flex";
  tags.style.flexWrap = "wrap";
  tags.style.gap = "4px";

  if (!skills.length) {
    const empty = document.createElement("div");
    empty.textContent = "No obvious skill keywords found.";
    empty.style.color = "#333333";
    empty.style.fontSize = "12px";
    tags.appendChild(empty);
  } else {
    for (const skill of skills) {
      const chip = document.createElement("div");
      chip.textContent = skill;
      chip.style.background = "#ffffff";
      chip.style.border = "1px solid #111111";
      chip.style.color = "#111111";
      chip.style.padding = "3px 7px";
      chip.style.borderRadius = "4px";
      chip.style.fontSize = "12px";
      chip.style.fontWeight = "600";
      tags.appendChild(chip);
    }
  }

  section.appendChild(tags);
  return section;
}

function buildBenefitsSummary(context) {
  const merged = [context?.title, context?.description, context?.company].map((item) => String(item || "")).join("\n");
  const benefits = collectMentions(merged, benefitMatchers);

  const section = document.createElement("div");
  section.id = "easyApplyCopilotBenefitsSummary";
  section.style.marginTop = "8px";
  section.style.padding = "8px";
  section.style.background = "#eef9f0";
  section.style.border = "1px solid #9fd2a8";
  section.style.borderRadius = "8px";

  const title = document.createElement("div");
  title.textContent = "Benefits Mentioned";
  title.style.color = "#1d5f2e";
  title.style.fontSize = "12px";
  title.style.fontWeight = "700";
  title.style.marginBottom = "6px";
  section.appendChild(title);

  const tags = document.createElement("div");
  tags.style.display = "flex";
  tags.style.flexWrap = "wrap";
  tags.style.gap = "4px";

  if (!benefits.length) {
    const empty = document.createElement("div");
    empty.textContent = "No obvious benefits keywords found.";
    empty.style.color = "#2f5f38";
    empty.style.fontSize = "12px";
    tags.appendChild(empty);
  } else {
    for (const benefit of benefits) {
      const chip = document.createElement("div");
      chip.textContent = benefit;
      chip.style.background = "#d7f0dc";
      chip.style.border = "1px solid #7ab38a";
      chip.style.color = "#1d5f2e";
      chip.style.padding = "3px 7px";
      chip.style.borderRadius = "4px";
      chip.style.fontSize = "12px";
      chip.style.fontWeight = "600";
      tags.appendChild(chip);
    }
  }

  section.appendChild(tags);
  return section;
}

function renderStaticSummaries(container, context) {
  if (!container || !container.isConnected) {
    return;
  }

  const scam = assessScamSignals(context);
  container.replaceChildren(
    buildRisksSummary(scam.signals),
    buildSkillsSummary(context),
    buildBenefitsSummary(context)
  );
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
    noRiskDiv.textContent = "No obvious risks found";
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
  renderStaticSummaries(staticBody, context);

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
    renderStaticSummaries(staticBody, context);
  }

  if (analyzeBtn && reviewBody) {
    analyzeBtn.addEventListener("click", () => runLinkedInInlineReview(wrapper, reviewBody));
  }

  if (generateBtn && reviewBody) {
    generateBtn.addEventListener("click", () => runLinkedInGenerateResume(wrapper, reviewBody));
  }

  syncLinkedInReviewWidgetState(wrapper);
}

async function initInlineReviewWidget() {
  if (!location.hostname.includes("linkedin.com")) {
    return;
  }

  injectLinkedInReviewWidget();
  runLinkedInScamCoverPass();

  const container = await untilAppears(".jobs-description__container");

  let wrapper = document.getElementById(REVIEW_WIDGET_ID);
  if (!wrapper) {
    injectLinkedInReviewWidget();
    wrapper = document.getElementById(REVIEW_WIDGET_ID);
  }

  const observer = new MutationObserver(() => {
    syncLinkedInReviewWidgetState(wrapper);
    runLinkedInScamCoverPass();
  });

  observer.observe(container, { attributes: true, childList: true, subtree: true });
}


new MutationObserver(() => {
  if (!location.hostname.includes("linkedin.com")) return;

  closeUselessLinkedInPopups()
}).observe(document.body, { childList: true, subtree: true });

function closeUselessLinkedInPopups() {
  // Application sent
  // Added to your applied jobs
  
  // const modalContainer = document.querySelector("#artdeco-modal-outlet > *:not(.jobs-easy-apply-modal)")
  // if (modalContainer.childNodes.length > 0) findDismissButton(modalContainer)?.click()
}

function untilAppears(selector, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const element = document.querySelector(selector);
    if (element) {
      resolve(element);
      return;
    }

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Element ${selector} did not appear within ${timeout}ms`));
    }, timeout);
  });
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
