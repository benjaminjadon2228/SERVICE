const callBtn = document.getElementById("callBtn");
const chatStream = document.getElementById("chatStream");
const botStatus = document.getElementById("botStatus");
const micStatus = document.getElementById("micStatus");
const demoQuestion = document.getElementById("demoQuestion");
const holoFigure = document.getElementById("holoFigure");

const defaultSources = [
  {
    id: "ecommerce_orders",
    label: "Ecommerce Orders",
    type: "csv",
    url: "data/sample_datasets_for_customer_service_chatbot_1__sample_datasets_for_customer_se.csv",
  },
  {
    id: "food_delivery",
    label: "Food Delivery",
    type: "csv",
    url: "data/sample_datasets_for_customer_service_chatbot__sample_datasets_for_customer_se.csv",
  },
];

let knowledgeBase = [];
let policyRules = {
  block: [],
  redact: [],
};
let recognition = null;
let isCallLive = false;

const speechSupported =
  "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
const isSecureContext = window.isSecureContext || location.hostname === "localhost";

const createMessage = (text, role) => {
  const wrapper = document.createElement("div");
  wrapper.className = `message message--${role}`;
  const p = document.createElement("p");
  p.textContent = text;
  wrapper.appendChild(p);
  chatStream.appendChild(wrapper);
  chatStream.scrollTop = chatStream.scrollHeight;
};

const toggleHologram = (active) => {
  if (active) {
    holoFigure.classList.add("is-active");
  } else {
    holoFigure.classList.remove("is-active", "is-speaking");
  }
};

const setSpeaking = (speaking) => {
  if (speaking) {
    holoFigure.classList.add("is-active", "is-speaking");
  } else {
    holoFigure.classList.remove("is-speaking");
  }
};

const parseCsv = (text) => {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((value) => value.trim());
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    return row;
  });
};

const normalize = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const fieldHints = {
  status: ["status", "delivery", "delivered", "in transit", "preparing"],
  refund: ["refund", "money back", "refunded", "refund status"],
  payment: ["payment", "charge", "charged", "coupon", "discount"],
  complaint: ["complaint", "issue", "problem", "reason"],
  resolution: ["resolution", "resolved", "solution"],
  notes: ["notes", "detail", "details", "explain"],
};

const scoreMatch = (question, blob) => {
  const qTokens = new Set(normalize(question).split(" "));
  const bTokens = new Set(normalize(blob).split(" "));
  let score = 0;
  qTokens.forEach((token) => {
    if (bTokens.has(token)) score += 1;
  });
  return score;
};

const inferPreferredField = (question) => {
  const normalized = normalize(question);
  for (const [field, hints] of Object.entries(fieldHints)) {
    if (hints.some((hint) => normalized.includes(hint))) {
      return field;
    }
  }
  return null;
};

const findRowByEntity = (question, rows) => {
  const normalized = normalize(question);
  let bestRow = null;
  let bestScore = 0;
  rows.forEach((row) => {
    const entityFields = [
      row.Product_Name,
      row.Item,
      row.Restaurant,
      row.Order_ID,
    ]
      .filter(Boolean)
      .map((value) => String(value));
    let score = 0;
    entityFields.forEach((field) => {
      const fieldNorm = normalize(field);
      if (fieldNorm && normalized.includes(fieldNorm)) {
        score += 6;
      } else {
        score += scoreMatch(question, field);
      }
    });
    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  });
  return { row: bestRow, score: bestScore };
};

const applyPolicies = (text) => {
  let filtered = text;
  policyRules.block.forEach((phrase) => {
    if (phrase && normalize(filtered).includes(normalize(phrase))) {
      filtered = "Sorry, that information cannot be shared.";
    }
  });
  policyRules.redact.forEach((phrase) => {
    if (phrase) {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filtered = filtered.replace(new RegExp(escaped, "gi"), "[redacted]");
    }
  });
  return filtered;
};

const routeQuestion = (question) => {
  let bestSource = knowledgeBase[0];
  let bestScore = 0;
  knowledgeBase.forEach((source) => {
    const candidate = `${source.label} ${source.searchBlob}`;
    const score = scoreMatch(question, candidate);
    if (score > bestScore) {
      bestScore = score;
      bestSource = source;
    }
  });
  return { source: bestSource, score: bestScore };
};

const answerFromSource = (question, source) => {
  if (!source) return null;
  if (source.type === "csv") {
    const preferredField = inferPreferredField(question);
    const entityMatch = findRowByEntity(question, source.rows);
    if (!entityMatch.row || entityMatch.score <= 0) return null;
    const row = entityMatch.row;
    if (preferredField) {
      const fieldMap = {
        status: row.Status,
        refund: row.Refund_Status,
        payment: row.Payment_Issue,
        complaint: row.Complaint_Type,
        resolution: row.Resolution,
        notes: row.Notes,
      };
      const value = fieldMap[preferredField];
      if (value) {
        return `${preferredField.replace(/^\w/, (c) => c.toUpperCase())}: ${value}`;
      }
    }
    return Object.entries(row)
      .map(([key, value]) => `${key}: ${value}`)
      .join(". ");
  }
  if (source.type === "txt") {
    const chunks = source.text.split(/\n{2,}/).map((chunk) => chunk.trim());
    let bestChunk = "";
    let bestScore = 0;
    chunks.forEach((chunk) => {
      const score = scoreMatch(question, chunk);
      if (score > bestScore) {
        bestScore = score;
        bestChunk = chunk;
      }
    });
    if (!bestChunk || bestScore <= 0) return null;
    return bestChunk;
  }
  return null;
};

const speak = async (text) => {
  setSpeaking(true);
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      throw new Error("TTS request failed");
    }

    const blob = await res.blob();
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      setSpeaking(false);
      toggleHologram(false);
    };
    await audio.play();
  } catch (err) {
    if ("speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.onend = () => {
        setSpeaking(false);
        toggleHologram(false);
      };
      window.speechSynthesis.speak(utterance);
    } else {
      setSpeaking(false);
      toggleHologram(false);
    }
  }
};

const handleQuestion = (question) => {
  if (!question.trim()) return;
  createMessage(question, "user");
  botStatus.textContent = "Analyzing data sources";
  toggleHologram(true);
  const route = routeQuestion(question);
  const rawAnswer = answerFromSource(question, route.source);
  const fallbackResponse =
    "We are working on your query. We take this as a complaint and will send your response in a quiet while.";
  if (!rawAnswer || route.score <= 0) {
    setTimeout(() => {
      createMessage(fallbackResponse, "bot");
      botStatus.textContent = "Ready to assist";
      speak(fallbackResponse);
    }, 500);
    return;
  }
  const finalAnswer = applyPolicies(rawAnswer);
  const response = `From ${route.source ? route.source.label : "knowledge base"}: ${finalAnswer}`;
  setTimeout(() => {
    createMessage(response, "bot");
    botStatus.textContent = "Ready to assist";
    speak(response);
  }, 500);
};

const loadDefaultData = async () => {
  const sources = await Promise.all(
    defaultSources.map(async (source) => {
      const res = await fetch(source.url);
      const text = await res.text();
      if (source.type === "csv") {
        const rows = parseCsv(text);
        return {
          ...source,
          rows,
          searchBlob: rows.map((row) => Object.values(row).join(" ")).join(" "),
        };
      }
      return {
        ...source,
        text,
        searchBlob: text,
      };
    })
  );
  knowledgeBase = sources;
};

const loadPolicyFile = async () => {
  const res = await fetch("data/policy.txt");
  const text = await res.text();
  parsePolicy(text);
};

const parsePolicy = (text) => {
  const block = [];
  const redact = [];
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("BLOCK:")) {
      block.push(trimmed.replace("BLOCK:", "").trim());
    } else if (trimmed.startsWith("REDACT:")) {
      redact.push(trimmed.replace("REDACT:", "").trim());
    }
  });
  policyRules = { block, redact };
};

const requestMicAccess = async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia-unsupported");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
};

const initSpeech = () => {
  if (!speechSupported) {
    micStatus.textContent = "Speech recognition not supported in this browser.";
    return;
  }
  if (!isSecureContext) {
    micStatus.textContent = "Speech recognition requires HTTPS or localhost.";
    return;
  }
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.continuous = true;

  recognition.onstart = () => {
    micStatus.textContent = "Listening...";
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    handleQuestion(transcript);
  };

  recognition.onerror = (event) => {
    const reason = event?.error || "unknown";
    if (reason === "not-allowed" || reason === "permission-denied") {
      micStatus.textContent = "Microphone permission denied by browser or OS.";
    } else if (reason === "no-speech") {
      micStatus.textContent = "No speech detected. Try again.";
    } else {
      micStatus.textContent = "Microphone error. Check permissions.";
    }
    isCallLive = false;
    callBtn.classList.remove("is-live");
    callBtn.textContent = "Call Log";
    botStatus.textContent = "Ready to assist";
  };

  recognition.onend = () => {
    if (isCallLive) {
      setTimeout(() => {
        try {
          recognition.start();
        } catch (err) {
          micStatus.textContent = "Microphone restart failed.";
        }
      }, 350);
    } else {
      micStatus.textContent = "Microphone idle";
    }
  };
};

callBtn.addEventListener("click", async () => {
  if (!speechSupported) {
    createMessage("Speech recognition is not available here.", "bot");
    return;
  }
  if (!isSecureContext) {
    createMessage("Voice capture needs HTTPS or localhost.", "bot");
    return;
  }
  isCallLive = !isCallLive;
  callBtn.classList.toggle("is-live", isCallLive);
  callBtn.textContent = isCallLive ? "End Call" : "Call Log";
  botStatus.textContent = isCallLive ? "Call live" : "Ready to assist";
  if (isCallLive) {
    try {
      await requestMicAccess();
      recognition.start();
    } catch (err) {
      const reason = err?.name || err?.message || "unknown";
      createMessage(`Microphone access failed (${reason}).`, "bot");
      isCallLive = false;
      callBtn.classList.remove("is-live");
      callBtn.textContent = "Call Log";
      botStatus.textContent = "Ready to assist";
    }
  } else if (recognition) {
    recognition.stop();
  }
});

demoQuestion.addEventListener("click", () => {
  handleQuestion("What is your standard delivery time for domestic orders?");
});

const boot = async () => {
  await loadDefaultData();
  await loadPolicyFile();
  initSpeech();
};

boot();
