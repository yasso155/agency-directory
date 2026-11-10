import { firebaseConfig } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);

/* ===== إعدادات التغذية والبوت ===== */
const CURRENCY = "ريال";
const buildMessage = (amount, agencyName) => `تم تغذية مبلغ ${amount} ${CURRENCY} لوكالة ${agencyName}`;
const DUP_WINDOW_MS = 15 * 60 * 1000;   // تحذير في حال تكرار نفس الوكالة ونفس المبلغ خلال 15 دقيقة
const BOT_STALE_MS = 3 * 60 * 1000;     // يُعتبر البوت منقطعاً بعد 3 دقائق دون نبض
const MAX_PINNED = 5;                   // الحد الأقصى للوكالات المثبتة

const STATUS = {
  pending: { text: "في الانتظار", cls: "pending" },
  sending: { text: "جاري الإرسال...", cls: "pending" },
  sent: { text: "أُرسلت للجروب ✓", cls: "sent" },
  failed: { text: "فشل الإرسال", cls: "failed" },
};

if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("YOUR_")) {
  $("setup").hidden = false;
  $("app").hidden = true;
} else {
  start();
}

async function start() {
  const V = "10.14.1";
  const base = `https://www.gstatic.com/firebasejs/${V}`;
  const [{ initializeApp }, fsMod] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-firestore.js`),
  ]);
  const {
    initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp,
    query, orderBy, limit,
  } = fsMod;

  const app = initializeApp(firebaseConfig);
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });

  const agenciesCol = collection(db, "agencies");
  const topupsCol = collection(db, "topups");
  const topupsQ = query(topupsCol, orderBy("createdAt", "desc"), limit(1000));
  const botDoc = doc(db, "system", "bot");
  const mentionsCol = collection(db, "mentions");
  const mentionsQ = query(mentionsCol, orderBy("createdAt", "desc"), limit(50));

  let items = [];            // قائمة الوكالات
  let topups = [];           // قائمة التغذيات (الأحدث أولاً)
  let term = "";             // نص البحث المشترك
  let currentView = "agencies"; // "agencies" | "history"
  let editingId = null;
  let armedId = null;
  let armTimer = null;
  let agenciesLoaded = false;
  let topupsLoaded = false;
  let firstSnap = true;
  let botSeen;               // undefined = لم يُحمّل بعد، 0 = لا توجد وثيقة، غير ذلك = توقيت آخر نبض
  let botWa = null;
  let toastTimer = null;
  const expandedIds = new Set();

  /* ---------- دوال مساعدة ---------- */
  const norm = (s) =>
    String(s || "").toLowerCase()
      .replace(/[ً-ٰٟـ]/g, "")
      .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
      .replace(/\s+/g, " ").trim();

  const fmtNum = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const two = (n) => String(n).padStart(2, "0");
  const fmtWhen = (ms) => {
    if (!ms) return "";
    const d = new Date(ms);
    return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
  };

  const agencyName = (a) => a.ar || a.en || a.id || "الوكالة";

  const showNote = (t) => { const n = $("note"); n.textContent = t || ""; n.hidden = !t; };

  function toast(t) {
    const x = $("toast");
    x.textContent = t;
    x.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { x.hidden = true; }, 3500);
  }

  function copyText(text) {
    return new Promise((resolve, reject) => {
      const fallback = () => {
        try {
          const ta = document.createElement("textarea");
          ta.value = text; ta.setAttribute("readonly", "");
          ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.select();
          const ok = document.execCommand("copy");
          document.body.removeChild(ta);
          ok ? resolve() : reject();
        } catch (e) { reject(e); }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(resolve, fallback);
      } else { fallback(); }
    });
  }

  const errText = (e) => {
    const c = e && e.code;
    if (c === "permission-denied") return "ليس لديك صلاحية الوصول إلى قاعدة البيانات. يُرجى مراجعة إعدادات الأمان.";
    if (c === "unavailable") return "تعذر الاتصال بالخادم، يُرجى التحقق من اتصالك بالإنترنت.";
    return "حدث خطأ أثناء تنفيذ العملية، يُرجى المحاولة مرة أخرى.";
  };

  function parseAmount(s) {
    const t = String(s || "")
      .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632))
      .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776))
      .replace(/٫/g, ".")
      .replace(/[,٬،\s]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    const n = Number(t);
    return n > 0 && n <= 10000000 ? n : null;
  }

  /* ---------- فحص حالة البوت والواتساب ---------- */
  function checkBotHealth() {
    const note = $("botNote");
    if (!note) return;
    if (botSeen === undefined) { note.hidden = true; return; }
    if (botSeen === 0 || Date.now() - botSeen > BOT_STALE_MS) {
      note.textContent = "⚠️ تنبيه: بوت واتساب متوقف أو السيرفر غير متصل. التغذيات الجديدة ستُحفظ في السجل وتُرسل تلقائياً للجروب عند عودة تشغيل البوت.";
      note.hidden = false;
      return;
    }
    if (botWa === "closed") {
      note.textContent = "⚠️ تنبيه: واتساب مفصول في سيرفر البوت. يُرجى إعادة مسح الباركود أو ربط الرقم عبر السيرفر.";
      note.hidden = false;
      return;
    }
    note.hidden = true;
  }
  setInterval(checkBotHealth, 30000);

  /* ---------- عرض الوكالات (Agencies Render) ---------- */
  function renderAgencies() {
    const list = $("list");
    list.textContent = "";
    const nq = norm(term);
    const shown = items.filter((it) =>
      !nq || norm(it.ar).includes(nq) || norm(it.en).includes(nq) || norm(it.id).includes(nq));

    // الترتيب: الوكالات المثبتة أولاً (بحد أقصى 5)، ثم الترتيب الأبجدي
    shown.sort((a, b) => {
      const aPin = Boolean(a.pinned);
      const bPin = Boolean(b.pinned);
      if (aPin !== bPin) return aPin ? -1 : 1;
      return (a.ar || a.en || "").localeCompare(b.ar || b.en || "", "ar");
    });

    const pinnedCount = items.filter((i) => i.pinned).length;
    if (!agenciesLoaded) {
      $("count").textContent = "جارٍ التحميل...";
    } else if (nq) {
      $("count").textContent = `عرض ${shown.length} من أصل ${items.length} وكالة`;
    } else {
      const pinText = pinnedCount > 0 ? ` (${pinnedCount} مثبتة)` : "";
      $("count").textContent = items.length === 0 ? "لا توجد وكالات" : `${items.length} وكالة مسجلة${pinText}`;
    }

    if (!shown.length) {
      const e = document.createElement("li");
      e.className = "empty";
      const iconWrap = document.createElement("div");
      iconWrap.className = "empty-icon";
      iconWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;
      const s = document.createElement("strong");
      const p = document.createElement("span");
      if (!agenciesLoaded) {
        s.textContent = "جارٍ تحميل قائمة الوكالات...";
        p.textContent = "يُرجى الانتظار لحظات للاتصال بقاعدة البيانات.";
      } else if (!items.length) {
        s.textContent = "لا توجد وكالات مسجلة حتى الآن";
        p.textContent = "يمكنك إضافة أول وكالة باستخدام النموذج أعلاه.";
      } else {
        s.textContent = "لم يتم العثور على أي نتائج مطابقة";
        p.textContent = "يرجى تجربة كلمة بحث أخرى أو التأكد من معرف الوكالة (ID).";
      }
      e.append(iconWrap, s, p);
      list.appendChild(e);
      return;
    }

    for (const it of shown) {
      const isExpanded = expandedIds.has(it._id);
      const isPinned = Boolean(it.pinned);
      const li = document.createElement("li");
      li.className = "row" + (isExpanded ? " expanded" : "") + (isPinned ? " pinned" : "");
      li.setAttribute("role", "button");
      li.setAttribute("tabindex", "0");
      li.setAttribute("aria-expanded", isExpanded ? "true" : "false");
      li.setAttribute("title", isExpanded ? "انقر لتصغير البطاقة" : "انقر لتكبير البطاقة وإظهار الخيارات");

      const toggleExpand = () => {
        if (expandedIds.has(it._id)) {
          expandedIds.delete(it._id);
          li.classList.remove("expanded");
          li.setAttribute("aria-expanded", "false");
          li.setAttribute("title", "انقر لتكبير البطاقة وإظهار الخيارات");
          const expBtn = li.querySelector(".expand-btn");
          if (expBtn) expBtn.setAttribute("aria-label", "تكبير وإظهار الخيارات");
        } else {
          expandedIds.add(it._id);
          li.classList.add("expanded");
          li.setAttribute("aria-expanded", "true");
          li.setAttribute("title", "انقر لتصغير البطاقة");
          const expBtn = li.querySelector(".expand-btn");
          if (expBtn) expBtn.setAttribute("aria-label", "تصغير البطاقة");
        }
      };

      li.addEventListener("click", (e) => {
        if (e.target.closest("button, a, input, select, textarea, .idchip")) return;
        toggleExpand();
      });

      li.addEventListener("keydown", (e) => {
        if (e.target === li && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          toggleExpand();
        }
      });

      const names = document.createElement("div");
      names.className = "names";
      if (isPinned) {
        const pinBadge = document.createElement("span");
        pinBadge.className = "pin-badge";
        pinBadge.title = "وكالة مثبتة في الأعلى";
        pinBadge.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6l.8 1 .8-1v-6H18v-2l-2-2z"/></svg><span>مثبتة</span>`;
        names.appendChild(pinBadge);
      }
      if (it.ar) {
        const a = document.createElement("span");
        a.className = "ar";
        a.textContent = it.ar;
        names.appendChild(a);
      }
      if (it.ar && it.en) {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = "-";
        names.appendChild(sep);
      }
      if (it.en) {
        const en = document.createElement("span");
        en.className = "en";
        en.textContent = it.en;
        names.appendChild(en);
      }
      li.appendChild(names);

      const box = document.createElement("div");
      box.className = "idbox";
      const chip = document.createElement("span");
      chip.className = "idchip"; chip.textContent = it.id;
      const cb = document.createElement("button");
      cb.type = "button"; cb.className = "btn-copy"; cb.textContent = "نسخ ID";
      cb.addEventListener("click", (e) => {
        e.stopPropagation();
        copyText(it.id).then(() => {
          cb.textContent = "تم النسخ ✓"; cb.classList.add("done");
        }, () => {
          cb.textContent = "تحديد ونسخ";
          const r = document.createRange(); r.selectNodeContents(chip);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        });
        setTimeout(() => { cb.textContent = "نسخ ID"; cb.classList.remove("done"); }, 1800);
      });

      const expBtn = document.createElement("button");
      expBtn.type = "button";
      expBtn.className = "expand-btn";
      expBtn.setAttribute("aria-label", isExpanded ? "تصغير البطاقة" : "تكبير وإظهار الخيارات");
      expBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
      expBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleExpand();
      });

      box.append(chip, cb, expBtn);
      li.appendChild(box);

      const tools = document.createElement("div");
      tools.className = "tools";

      // 1. زر التغذية
      const tb = document.createElement("button");
      tb.type = "button";
      tb.className = "btn-topup";
      tb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg><span>تغذية</span>`;
      tb.addEventListener("click", (e) => {
        e.stopPropagation();
        openTopup(it);
      });

      // 2. زر التثبيت
      const pb = document.createElement("button");
      pb.type = "button";
      pb.className = "btn-pin" + (isPinned ? " is-pinned" : "");
      pb.innerHTML = isPinned
        ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6l.8 1 .8-1v-6H18v-2l-2-2z"/></svg><span>إلغاء التثبيت</span>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6l.8 1 .8-1v-6H18v-2l-2-2z"/></svg><span>تثبيت في الأعلى (${pinnedCount}/5)</span>`;
      pb.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePin(it);
      });

      // 3. زر التعديل
      const eb = document.createElement("button");
      eb.type = "button";
      eb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg><span>تعديل</span>`;
      eb.addEventListener("click", (e) => {
        e.stopPropagation();
        startEdit(it);
      });

      // 4. زر الحذف
      const db_ = document.createElement("button");
      db_.type = "button";
      db_.className = "danger" + (armedId === it._id ? " armed" : "");
      db_.innerHTML = armedId === it._id
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>تأكيد الحذف نهائياً</span>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>حذف</span>`;
      db_.addEventListener("click", (e) => {
        e.stopPropagation();
        onDelete(it);
      });

      tools.append(tb, pb, eb, db_);
      li.appendChild(tools);

      list.appendChild(li);
    }
  }

  /* ---------- التثبيت والتعديل والحذف ---------- */
  async function togglePin(it) {
    const isPinned = Boolean(it.pinned);
    if (!isPinned) {
      const currentPinned = items.filter((x) => x.pinned).length;
      if (currentPinned >= MAX_PINNED) {
        showNote(`⚠️ تنبيه: تم الوصول للحد الأقصى (${MAX_PINNED} وكالات مثبتة). يُرجى إلغاء تثبيت إحدى الوكالات أولاً لتتمكن من تثبيت غيرها.`);
        setTimeout(() => showNote(""), 5000);
        return;
      }
    }
    showNote("");
    try {
      await updateDoc(doc(db, "agencies", it._id), { pinned: !isPinned });
    } catch (e) {
      showNote(errText(e));
    }
  }

  function startEdit(it) {
    editingId = it._id;
    $("ar").value = it.ar || ""; $("en").value = it.en || ""; $("aid").value = it.id || "";
    $("formTitle").textContent = "تعديل بيانات الوكالة";
    $("save").textContent = "حفظ التعديلات";
    $("cancel").hidden = false; $("msg").textContent = "";
    $("addbox").open = true;
    $("addbox").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetForm() {
    editingId = null;
    $("form").reset();
    $("formTitle").textContent = "إضافة وكالة جديدة";
    $("save").textContent = "حفظ البيانات";
    $("cancel").hidden = true; $("msg").textContent = "";
  }

  function onDelete(it) {
    if (armedId !== it._id) {
      armedId = it._id;
      expandedIds.add(it._id);
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { armedId = null; renderAgencies(); }, 3500);
      renderAgencies();
      return;
    }
    armedId = null; clearTimeout(armTimer);
    expandedIds.delete(it._id);
    deleteDoc(doc(db, "agencies", it._id)).then(
      () => { if (editingId === it._id) resetForm(); },
      (e) => showNote(errText(e)));
    renderAgencies();
  }

  /* ---------- نافذة التغذية (Topup Dialog) ---------- */
  let dlgAgency = null;
  let dupAck = false;
  let savingTopup = false;
  let currentAttachment = null; // { type, name, mimetype, data, size }

  // تشغيل نغمة تنبيه لطيفة بدون ملفات صوت خارجية
  function playChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.setValueAtTime(880, now + 0.12); // A5
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.6);
    } catch { /* تجاهل قيود الصوت للمتصفح */ }
  }

  // ضغط الصور تلقائياً لتناسب قاعدة البيانات وسرعة الإرسال
  function compressImage(file, maxWidth = 1280, quality = 0.78) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let w = img.width;
          let h = img.height;
          if (w > maxWidth || h > maxWidth) {
            if (w > h) {
              h = Math.round((h * maxWidth) / w);
              w = maxWidth;
            } else {
              w = Math.round((w * maxWidth) / h);
              h = maxWidth;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL("image/jpeg", quality);
          resolve(dataUrl);
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function resetAttachment() {
    currentAttachment = null;
    $("dlgFile").value = "";
    $("fileCard").hidden = true;
    $("btnChooseFile").hidden = false;
    $("fileImgThumb").hidden = true;
    $("filePdfIcon").hidden = true;
    $("fileImgThumb").src = "";
  }

  $("btnChooseFile").addEventListener("click", () => $("dlgFile").click());

  $("dlgFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isImg = file.type.startsWith("image/");
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

    if (!isImg && !isPdf) {
      alert("يُرجى اختيار صورة (JPG/PNG) أو ملف PDF فقط.");
      resetAttachment();
      return;
    }
    if (isPdf && file.size > 800 * 1024) {
      alert("حجم ملف الـ PDF كبير (الحد الأقصى 800 كيلوبايت). يُرجى اختيار ملف أصغر.");
      resetAttachment();
      return;
    }

    try {
      let dataUrl = "";
      if (isImg) {
        dataUrl = await compressImage(file);
      } else {
        dataUrl = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = rej;
          r.readAsDataURL(file);
        });
      }

      currentAttachment = {
        type: isImg ? "image" : "pdf",
        name: file.name,
        mimetype: isImg ? "image/jpeg" : "application/pdf",
        data: dataUrl,
        size: Math.round(dataUrl.length * 0.75),
      };

      $("fileCardName").textContent = file.name;
      $("fileCardSize").textContent = `${Math.round(currentAttachment.size / 1024)} كيلوبايت`;
      if (isImg) {
        $("fileImgThumb").src = dataUrl;
        $("fileImgThumb").hidden = false;
        $("filePdfIcon").hidden = true;
      } else {
        $("fileImgThumb").hidden = true;
        $("filePdfIcon").hidden = false;
      }
      $("fileCard").hidden = false;
      $("btnChooseFile").hidden = true;
    } catch (err) {
      console.error("خطأ في قراءة المرفق:", err);
      alert("تعذر قراءة الملف المرفق. يُرجى المحاولة مرة أخرى.");
      resetAttachment();
    }
  });

  $("btnRemoveFile").addEventListener("click", resetAttachment);

  function updatePreview() {
    if (!dlgAgency) return;
    const amt = parseAmount($("amount").value);
    const amtFormatted = amt === null ? "…" : fmtNum(amt);
    $("dlgPreview").textContent = buildMessage(amtFormatted, agencyName(dlgAgency));
  }

  function resetDup() {
    dupAck = false;
    $("dupWarn").hidden = true;
    $("dlgConfirm").textContent = "تمت التغذية، أرسل للجروب";
  }

  function openTopup(it) {
    dlgAgency = it;
    $("dlgAr").textContent = it.ar || "";
    $("dlgEn").textContent = it.en || "";
    $("dlgId").textContent = it.id || "";
    $("amount").value = "";
    $("tnote").value = "";
    $("dlgMsg").textContent = "";
    resetAttachment();
    resetDup();
    updatePreview();
    $("dlg").showModal();
    $("amount").focus();
  }

  $("amount").addEventListener("input", () => {
    resetDup();
    updatePreview();
  });

  $("dlgCancel").addEventListener("click", () => {
    resetAttachment();
    $("dlg").close();
  });

  $("topupForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (savingTopup || !dlgAgency) return;
    const msg = $("dlgMsg");
    msg.textContent = "";
    const amount = parseAmount($("amount").value);
    if (amount === null) {
      msg.textContent = "يُرجى كتابة مبلغ صحيح أكبر من صفر بالأرقام.";
      $("amount").focus();
      return;
    }

    const a = dlgAgency;

    // فحص منع التكرار (خلال 15 دقيقة)
    const recent = topups.find((t) => t.agencyId === a._id && t.amount === amount && (Date.now() - t.time < DUP_WINDOW_MS));
    if (recent && !dupAck) {
      dupAck = true;
      const mins = Math.max(1, Math.round((Date.now() - recent.time) / 60000));
      const w = $("dupWarn");
      w.textContent = `⚠️ تنبيه تكرار: توجد تغذية مسجلة بنفس المبلغ (${fmtNum(amount)} ${CURRENCY}) لنفس الوكالة قبل ${mins} دقيقة. إذا كانت هذه تغذية جديدة منفصلة، اضغط زر التأكيد أدناه للمتابعة.`;
      w.hidden = false;
      $("dlgConfirm").textContent = "تأكيد وإرسال للجروب رغم التكرار";
      return;
    }

    savingTopup = true;
    $("dlgConfirm").disabled = true;
    const slowTimer = setTimeout(() => {
      msg.textContent = "الاتصال بطيء. البيانات محفوظة محلياً وستُرفع تلقائياً عند استقرار النت. لا تضغط مجدداً.";
    }, 8000);

    try {
      const topupDoc = {
        agencyId: a._id,
        agencyAr: a.ar || "",
        agencyEn: a.en || "",
        agencyCode: a.id,
        amount,
        currency: CURRENCY,
        note: $("tnote").value.trim(),
        message: buildMessage(fmtNum(amount), agencyName(a)),
        createdAt: serverTimestamp(),
        createdBy: "web",
        notify: { status: "pending" },
      };
      if (currentAttachment && currentAttachment.data) {
        topupDoc.attachment = currentAttachment;
      }

      await addDoc(topupsCol, topupDoc);
      resetAttachment();
      $("dlg").close();
      toast(`✓ تمت تغذية ${agencyName(a)} بمبلغ ${fmtNum(amount)} ${CURRENCY} وجارٍ إرسالها للجروب.`);
    } catch (e) {
      msg.textContent = errText(e);
    }

    clearTimeout(slowTimer);
    savingTopup = false;
    $("dlgConfirm").disabled = false;
  });

  /* ---------- سجل التغذيات (History View) ---------- */
  function getFilteredTopups() {
    const nq = norm(term);
    const range = $("range").value;
    let since = 0;
    if (range === "today") {
      const now = new Date();
      since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    } else if (range === "7") {
      since = Date.now() - 7 * 86400000;
    }

    return topups.filter((t) => {
      if (t.time < since) return false;
      if (!nq) return true;
      return norm(t.agencyAr).includes(nq) ||
             norm(t.agencyEn).includes(nq) ||
             norm(t.agencyCode).includes(nq) ||
             norm(t.note).includes(nq);
    });
  }

  async function retryTopup(t) {
    try {
      await updateDoc(doc(db, "topups", t._id), { notify: { status: "pending" } });
      toast("تمت إعادة جدولة الرسالة للبوت ✓");
    } catch (e) {
      showNote(errText(e));
    }
  }

  function renderHistory() {
    const ul = $("hist");
    ul.textContent = "";
    const rows = getFilteredTopups();
    const total = rows.reduce((s, t) => s + (t.amount || 0), 0);

    $("histSummary").textContent = topupsLoaded && rows.length
      ? `${rows.length} تغذية · المجموع: ${fmtNum(total)} ${CURRENCY}`
      : "";

    if (!rows.length) {
      const e = document.createElement("li");
      e.className = "empty";
      const iconWrap = document.createElement("div");
      iconWrap.className = "empty-icon";
      iconWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
      const s = document.createElement("strong");
      const p = document.createElement("span");
      if (!topupsLoaded) {
        s.textContent = "جارٍ تحميل سجل التغذيات...";
        p.textContent = "يُرجى الانتظار لحظات للاتصال بقاعدة البيانات.";
      } else if (!topups.length) {
        s.textContent = "لا توجد تغذيات مسجلة حتى الآن";
        p.textContent = "ستظهر هنا جميع التغذيات بعد تنفيذ أول تغذية من تبويب الوكالات.";
      } else {
        s.textContent = "لا توجد نتائج مطابقة في هذه الفترة";
        p.textContent = "جرّب تغيير فلتر الفترة أو كلمة البحث.";
      }
      e.append(iconWrap, s, p);
      ul.appendChild(e);
      return;
    }

    for (const t of rows) {
      const li = document.createElement("li");
      li.className = "row hrow";

      const names = document.createElement("div");
      names.className = "names";

      const titleWrap = document.createElement("div");
      titleWrap.style.display = "flex";
      titleWrap.style.alignItems = "baseline";
      titleWrap.style.gap = "8px";
      titleWrap.style.flexWrap = "wrap";

      if (t.agencyAr) {
        const ar = document.createElement("span");
        ar.className = "ar";
        ar.textContent = t.agencyAr;
        titleWrap.appendChild(ar);
      }
      if (t.agencyAr && t.agencyEn) {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = "-";
        titleWrap.appendChild(sep);
      }
      if (t.agencyEn) {
        const en = document.createElement("span");
        en.className = "en";
        en.textContent = t.agencyEn;
        titleWrap.appendChild(en);
      }
      if (t.agencyCode) {
        const c = document.createElement("span");
        c.className = "idchip";
        c.style.padding = "2px 8px";
        c.style.fontSize = "0.8rem";
        c.textContent = t.agencyCode;
        titleWrap.appendChild(c);
      }
      names.appendChild(titleWrap);

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = fmtWhen(t.time) + (t.note ? ` · ${t.note}` : "");
      names.appendChild(meta);

      li.appendChild(names);

      const amtBox = document.createElement("div");
      amtBox.className = "amtbox";
      const amtSpan = document.createElement("span");
      amtSpan.className = "amt";
      amtSpan.textContent = fmtNum(t.amount);
      const curSpan = document.createElement("span");
      curSpan.className = "cur";
      curSpan.textContent = CURRENCY;
      amtBox.append(amtSpan, curSpan);
      li.appendChild(amtBox);

      const st = STATUS[t.status] || STATUS.pending;
      const foot = document.createElement("div");
      foot.className = "tools";
      foot.style.display = "flex";

      const chip = document.createElement("span");
      chip.className = "chip " + st.cls;
      chip.textContent = st.text;
      foot.appendChild(chip);

      if (t.status === "failed" && t.error) {
        const err = document.createElement("span");
        err.className = "err";
        err.textContent = `السبب: ${t.error}`;
        foot.appendChild(err);
      }

      // زر معاينة المرفق (صورة أو PDF)
      if (t.attachment && t.attachment.data) {
        const attBtn = document.createElement("button");
        attBtn.type = "button";
        attBtn.className = "chip-attach";
        const isImg = t.attachment.type === "image" || t.attachment.mimetype?.startsWith("image/");
        attBtn.innerHTML = isImg
          ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg><span>معاينة الصورة</span>`
          : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>عرض الـ PDF</span>`;
        attBtn.addEventListener("click", () => openPreviewModal(t.attachment));
        foot.appendChild(attBtn);
      }

      // زر نسخ الرسالة
      const cp = document.createElement("button");
      cp.type = "button";
      cp.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg><span>نسخ الرسالة</span>`;
      cp.addEventListener("click", () => {
        copyText(t.message).then(
          () => toast("تم نسخ نص الرسالة للحافظة ✓"),
          () => toast("تعذر النسخ التلقائي")
        );
      });
      foot.appendChild(cp);

      // زر إعادة المحاولة في حال الفشل
      if (t.status === "failed") {
        const rb = document.createElement("button");
        rb.type = "button";
        rb.style.color = "var(--accent)";
        rb.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg><span>إعادة المحاولة</span>`;
        rb.addEventListener("click", () => retryTopup(t));
        foot.appendChild(rb);
      }

      // زر حذف التغذية من السجل
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-del";
      delBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>حذف</span>`;
      delBtn.addEventListener("click", async () => {
        const title = t.agencyAr || t.agencyEn || "الوكالة";
        if (confirm(`هل أنت متأكد من حذف تغذية "${title}" بمبلغ ${fmtNum(t.amount)} ${CURRENCY} من السجل نهائياً؟`)) {
          try {
            await deleteDoc(doc(db, "topups", t._id));
            toast("تم حذف التغذية من السجل بنجاح ✓");
          } catch (e) {
            showNote(errText(e));
          }
        }
      });
      foot.appendChild(delBtn);

      li.appendChild(foot);
      ul.appendChild(li);
    }
  }

  $("range").addEventListener("change", renderHistory);

  /* ---------- التبديل بين التبويبات والبحث ---------- */
  function switchTab(viewName) {
    currentView = viewName;
    const isAgencies = viewName === "agencies";
    $("tabAgencies").setAttribute("aria-selected", isAgencies ? "true" : "false");
    $("tabHistory").setAttribute("aria-selected", isAgencies ? "false" : "true");
    $("viewAgencies").hidden = !isAgencies;
    $("viewHistory").hidden = isAgencies;
    $("q").placeholder = isAgencies
      ? "ابحث باسم الوكالة بالعربية أو الإنجليزية أو المعرف (ID)..."
      : "ابحث في سجل التغذيات بالاسم أو المعرف أو الملاحظة...";

    if (isAgencies) renderAgencies();
    else renderHistory();
  }

  $("tabAgencies").addEventListener("click", () => switchTab("agencies"));
  $("tabHistory").addEventListener("click", () => switchTab("history"));

  $("q").addEventListener("input", (e) => {
    term = e.target.value;
    if (currentView === "agencies") renderAgencies();
    else renderHistory();
  });

  $("cancel").addEventListener("click", resetForm);

  // التحقق الفوري أثناء كتابة معرف الوكالة
  $("aid").addEventListener("input", (e) => {
    const val = e.target.value.trim();
    const msg = $("msg");
    if (val && !/^\d+$/.test(val)) {
      msg.textContent = "⚠️ تنبيه: يُسمح بالأرقام فقط في خانة الـ ID (0-9).";
      return;
    }
    if (val && items.some((i) => String(i.id).trim() === val && i._id !== editingId)) {
      msg.textContent = `⚠️ تحذير: رقم المعرف (${val}) مسجل مسبقاً لوكالة أخرى! لا يمكن تكراره.`;
      return;
    }
    if (msg.textContent.startsWith("⚠️")) {
      msg.textContent = "";
    }
  });

  $("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const msg = $("msg");
    const ar = $("ar").value.trim(), en = $("en").value.trim(), id = $("aid").value.trim();

    if (!id) {
      msg.textContent = "يُرجى إدخال معرّف الوكالة (ID).";
      $("aid").focus();
      return;
    }
    if (!/^\d+$/.test(id)) {
      msg.textContent = "⚠️ خطأ: يجب أن يتكون معرّف الوكالة (ID) من أرقام فقط (0-9).";
      $("aid").focus();
      return;
    }
    if (items.some((i) => String(i.id).trim() === id && i._id !== editingId)) {
      msg.textContent = `⚠️ تحذير: معرّف الوكالة (${id}) مسجل مسبقاً! هذا الرقم فريد (Unique) ولا يمكن تكراره.`;
      $("aid").focus();
      return;
    }
    if (!ar && !en) {
      msg.textContent = "يُرجى إدخال اسم الوكالة بالعربية أو الإنجليزية على الأقل.";
      $("ar").focus();
      return;
    }

    msg.textContent = "";
    const btn = $("save"); btn.disabled = true;
    try {
      if (editingId) await updateDoc(doc(db, "agencies", editingId), { ar, en, id });
      else await addDoc(agenciesCol, { ar, en, id, createdAt: serverTimestamp() });
      resetForm(); $("ar").focus();
    } catch (e) { msg.textContent = errText(e); }
    btn.disabled = false;
  });

  /* ---------- نافذة معاينة المرفق (Lightbox) ---------- */
  function openPreviewModal(att) {
    const body = $("previewModalBody");
    body.innerHTML = "";
    const isImg = att.type === "image" || att.mimetype?.startsWith("image/");
    if (isImg) {
      const img = document.createElement("img");
      img.src = att.data;
      img.alt = att.name || "معاينة الإيصال";
      body.appendChild(img);
    } else {
      const iframe = document.createElement("iframe");
      iframe.src = att.data;
      body.appendChild(iframe);
    }
    $("previewDlg").showModal();
  }
  $("btnClosePreviewDlg").addEventListener("click", () => $("previewDlg").close());

  /* ---------- إشعارات المنشن والبوب أب (Mentions & Notifications) ---------- */
  let mentionsList = [];
  let initialMentionsLoaded = false;
  let seenMentionIds = new Set(JSON.parse(localStorage.getItem("seen_mentions") || "[]"));

  function saveSeenMentions() {
    try {
      localStorage.setItem("seen_mentions", JSON.stringify([...seenMentionIds].slice(-100)));
    } catch {}
  }

  function updateBellBadge() {
    const unreadCount = mentionsList.filter((m) => !seenMentionIds.has(m._id)).length;
    const badge = $("bellBadge");
    if (!badge) return;
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  function showMentionPopup(m) {
    $("mentionSender").textContent = `من: ${m.senderName || m.senderPhone || "شخص ما"}`;
    $("mentionTime").textContent = fmtWhen(m.time);
    $("mentionText").textContent = m.text || "رسالة بدون نص";
    $("mentionPopup").hidden = false;

    playChime();

    // إشعار سطح المكتب للمتصفح إذا كان مسموحاً
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(`منشن جديد من ${m.senderName || "الواتساب"}`, {
          body: m.text,
          icon: "assets/favicon-32x32.png",
        });
      } catch {}
    }
  }

  $("btnCloseMention").addEventListener("click", () => {
    $("mentionPopup").hidden = true;
  });

  $("btnAckMention").addEventListener("click", () => {
    $("mentionPopup").hidden = true;
    if (mentionsList[0]) {
      seenMentionIds.add(mentionsList[0]._id);
      saveSeenMentions();
      updateBellBadge();
    }
  });

  // طلب إذن الإشعارات عند أول نقرة
  document.addEventListener("click", () => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, { once: true });

  function renderMentionsList() {
    const ul = $("mentionsList");
    ul.innerHTML = "";
    if (!mentionsList.length) {
      ul.innerHTML = '<li class="mentions-empty">لا توجد منشنات مسجلة حتى الآن</li>';
      return;
    }
    for (const m of mentionsList) {
      const li = document.createElement("li");
      li.className = "mentions-item";
      const isUnread = !seenMentionIds.has(m._id);
      if (isUnread) li.style.borderColor = "var(--accent)";

      const top = document.createElement("div");
      top.className = "mentions-item-top";
      top.innerHTML = `<strong>${m.senderName || m.senderPhone || "شخص ما"}</strong><span>${fmtWhen(m.time)}</span>`;

      const txt = document.createElement("p");
      txt.className = "mentions-item-text";
      txt.textContent = m.text;

      li.append(top, txt);
      ul.appendChild(li);
    }
  }

  $("btnMentionsBell").addEventListener("click", () => {
    for (const m of mentionsList) seenMentionIds.add(m._id);
    saveSeenMentions();
    updateBellBadge();
    renderMentionsList();
    $("mentionsDlg").showModal();
  });

  $("btnCloseMentionsDlg").addEventListener("click", () => $("mentionsDlg").close());

  /* ---------- الاستماع المباشر لقاعدة البيانات (Realtime Listeners) ---------- */
  function listen() {
    agenciesLoaded = false;
    topupsLoaded = false;
    firstSnap = true;
    renderAgencies();
    renderHistory();

    const timer = setTimeout(() => showNote("تعذر تحديث البيانات من الخادم، قد تكون القائمة الحالية غير مكتملة."), 10000);

    // 1. الوكالات
    onSnapshot(agenciesCol, (snap) => {
      items = snap.docs.map((d) => {
        const x = d.data();
        return {
          _id: d.id,
          ar: x.ar || "",
          en: x.en || "",
          id: String(x.id || ""),
          pinned: Boolean(x.pinned),
        };
      });
      agenciesLoaded = true;
      if (!snap.metadata.fromCache) { clearTimeout(timer); showNote(""); }
      if (firstSnap && items.length) $("addbox").open = false;
      firstSnap = false;
      renderAgencies();
    }, (e) => {
      clearTimeout(timer); agenciesLoaded = true;
      showNote(errText(e)); renderAgencies();
    });

    // 2. التغذيات
    onSnapshot(topupsQ, (snap) => {
      topups = snap.docs.map((d) => {
        const x = d.data();
        const t = x.createdAt?.toMillis?.() || Date.now();
        return {
          _id: d.id,
          agencyId: x.agencyId,
          agencyAr: x.agencyAr || "",
          agencyEn: x.agencyEn || "",
          agencyCode: x.agencyCode || "",
          amount: x.amount || 0,
          currency: x.currency || CURRENCY,
          note: x.note || "",
          message: x.message || "",
          attachment: x.attachment || null,
          time: t,
          status: x.notify?.status || "pending",
          error: x.notify?.error || null,
        };
      });
      topupsLoaded = true;
      renderHistory();
    }, (e) => {
      console.error("خطأ في تحميل التغذيات:", e);
      topupsLoaded = true;
      renderHistory();
    });

    // 3. نبض البوت
    onSnapshot(botDoc, (snap) => {
      if (!snap.exists()) {
        botSeen = 0;
        botWa = null;
      } else {
        const x = snap.data();
        botSeen = x.lastSeen?.toMillis?.() || 0;
        botWa = x.whatsapp || null;
      }
      checkBotHealth();
    }, (e) => {
      console.error("خطأ في قراءة نبض البوت:", e);
    });

    // 4. إشعارات المنشن
    onSnapshot(mentionsQ, (snap) => {
      const newItems = snap.docs.map((d) => {
        const x = d.data();
        return {
          _id: d.id,
          text: x.text || "",
          senderName: x.senderName || "",
          senderPhone: x.senderPhone || "",
          time: x.createdAt?.toMillis?.() || Date.now(),
        };
      });

      if (initialMentionsLoaded) {
        snap.docChanges().forEach((change) => {
          if (change.type === "added") {
            const d = change.doc;
            const x = d.data();
            const mentionObj = {
              _id: d.id,
              text: x.text || "",
              senderName: x.senderName || "",
              senderPhone: x.senderPhone || "",
              time: x.createdAt?.toMillis?.() || Date.now(),
            };
            showMentionPopup(mentionObj);
          }
        });
      } else {
        initialMentionsLoaded = true;
        const unreadRecent = newItems.find((m) => !seenMentionIds.has(m._id) && (Date.now() - m.time < 10 * 60 * 1000));
        if (unreadRecent) {
          showMentionPopup(unreadRecent);
        }
      }

      mentionsList = newItems;
      updateBellBadge();
    }, (e) => {
      console.error("خطأ في قراءة المنشنات:", e);
    });
  }

  listen();
}
