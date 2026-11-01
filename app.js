import { firebaseConfig } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);

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
  } = fsMod;

  const app = initializeApp(firebaseConfig);
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  const col = collection(db, "agencies");

  let items = [];
  let query = "";
  let editingId = null;
  let armedId = null;
  let armTimer = null;
  let loaded = false;
  let firstSnap = true;

  /* ---------- دوال مساعدة ---------- */
  const norm = (s) =>
    String(s || "").toLowerCase()
      .replace(/[ً-ٰٟـ]/g, "")
      .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
      .replace(/\s+/g, " ").trim();

  const showNote = (t) => { const n = $("note"); n.textContent = t || ""; n.hidden = !t; };

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

  /* ---------- عرض البيانات (Render) ---------- */
  function render() {
    const list = $("list");
    list.textContent = "";
    const nq = norm(query);
    const shown = items.filter((it) =>
      !nq || norm(it.ar).includes(nq) || norm(it.en).includes(nq) || norm(it.id).includes(nq));
    shown.sort((a, b) => (a.ar || a.en || "").localeCompare(b.ar || b.en || "", "ar"));

    if (!loaded) {
      $("count").textContent = "جارٍ التحميل...";
    } else if (nq) {
      $("count").textContent = `عرض ${shown.length} من أصل ${items.length} وكالة`;
    } else {
      $("count").textContent = items.length === 0 ? "لا توجد وكالات" : `${items.length} وكالة مسجلة`;
    }

    if (!shown.length) {
      const e = document.createElement("li");
      e.className = "empty";
      
      const iconWrap = document.createElement("div");
      iconWrap.className = "empty-icon";
      iconWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;

      const s = document.createElement("strong");
      const p = document.createElement("span");
      if (!loaded) {
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
      const li = document.createElement("li");
      li.className = "row";

      const names = document.createElement("div");
      names.className = "names";
      if (it.ar) { const a = document.createElement("div"); a.className = "ar"; a.textContent = it.ar; names.appendChild(a); }
      if (it.en) { const en = document.createElement("div"); en.className = "en"; en.textContent = it.en; names.appendChild(en); }
      li.appendChild(names);

      const box = document.createElement("div");
      box.className = "idbox";
      const chip = document.createElement("span");
      chip.className = "idchip"; chip.textContent = it.id;
      const cb = document.createElement("button");
      cb.type = "button"; cb.className = "btn-copy"; cb.textContent = "نسخ ID";
      cb.addEventListener("click", () => {
        copyText(it.id).then(() => {
          cb.textContent = "تم النسخ ✓"; cb.classList.add("done");
        }, () => {
          cb.textContent = "تحديد ونسخ";
          const r = document.createRange(); r.selectNodeContents(chip);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        });
        setTimeout(() => { cb.textContent = "نسخ ID"; cb.classList.remove("done"); }, 1800);
      });
      box.append(chip, cb);
      li.appendChild(box);

      const tools = document.createElement("div");
      tools.className = "tools";
      const eb = document.createElement("button");
      eb.type = "button"; eb.textContent = "تعديل";
      eb.addEventListener("click", () => startEdit(it));
      const db_ = document.createElement("button");
      db_.type = "button";
      db_.className = "danger" + (armedId === it._id ? " armed" : "");
      db_.textContent = armedId === it._id ? "تأكيد الحذف نهائياً" : "حذف";
      db_.addEventListener("click", () => onDelete(it));
      tools.append(eb, db_);
      li.appendChild(tools);

      list.appendChild(li);
    }
  }

  /* ---------- التعديل والحذف ---------- */
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
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { armedId = null; render(); }, 3500);
      render();
      return;
    }
    armedId = null; clearTimeout(armTimer);
    deleteDoc(doc(db, "agencies", it._id)).then(
      () => { if (editingId === it._id) resetForm(); },
      (e) => showNote(errText(e)));
    render();
  }

  $("q").addEventListener("input", (e) => { query = e.target.value; render(); });
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
      else await addDoc(col, { ar, en, id, createdAt: serverTimestamp() });
      resetForm(); $("ar").focus();
    } catch (e) { msg.textContent = errText(e); }
    btn.disabled = false;
  });

  /* ---------- الاستماع المباشر لقاعدة البيانات ---------- */
  function listen() {
    loaded = false; firstSnap = true; render();
    const timer = setTimeout(() => showNote("تعذر تحديث البيانات من الخادم، قد تكون القائمة الحالية غير مكتملة."), 10000);
    onSnapshot(col, (snap) => {
      items = snap.docs.map((d) => {
        const x = d.data();
        return { _id: d.id, ar: x.ar || "", en: x.en || "", id: String(x.id || "") };
      });
      loaded = true;
      if (!snap.metadata.fromCache) { clearTimeout(timer); showNote(""); }
      if (firstSnap && items.length) $("addbox").open = false;
      firstSnap = false;
      render();
    }, (e) => {
      clearTimeout(timer); loaded = true;
      showNote(errText(e)); render();
    });
  }

  listen();
}
