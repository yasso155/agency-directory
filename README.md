# دليل الوكالات

صفحة ثابتة (HTML + JS) تتصل بـ Firebase Auth و Firestore. ما فيها build ولا dependencies، تنشر على Vercel مباشرة.

## 1) إعداد Firebase

1. Firebase Console → أنشئ مشروع (أو استخدم مشروع موجود).
2. **Build → Firestore Database → Create database** (اختر أقرب منطقة، مثلاً `me-central2` الدمام أو `europe-west`).
3. **Build → Authentication → Sign-in method** → فعّل **Email/Password**.
4. **Authentication → Users → Add user** → أضف إيميلك وكلمة سر. هذا هو حسابك الوحيد.
5. **Project settings → General → Your apps → Web (`</>`)** → سجّل التطبيق وانسخ الـ config.
6. الصق الـ config في `firebase-config.js`.
7. افتح `firestore.rules`، غيّر `YOUR_EMAIL@example.com` لإيميلك، وانسخ المحتوى في **Firestore → Rules → Publish**.
   (أو عبر CLI: `firebase deploy --only firestore:rules`)

> قيم الـ config عامة وعادي تكون في الكود. الحماية الحقيقية من الـ Rules، لأن أي زول يقدر يفتح الصفحة لكن ما يقرا ولا يكتب إلا إيميلك.

## 2) النشر على Vercel

**الطريقة الأسرع (CLI):**

```bash
npm i -g vercel
cd agency-directory
vercel          # أول مرة: اختر Other كـ framework، ومجلد الإخراج الحالي ./
vercel --prod
```

**أو عبر GitHub:** ارفع المجلد لريبو → Vercel → Add New Project → Import → Framework Preset: **Other** → Deploy.

## 3) بعد النشر

في Firebase Console → **Authentication → Settings → Authorized domains** → أضف دومين Vercel (مثلاً `your-app.vercel.app`) وأي دومين خاص تربطه.

## ملاحظات

- Firestore فيه offline cache، فالصفحة تفتح على التلفون حتى لو النت ضعيف، وتتزامن لما يرجع.
- ما تفعّل تسجيل مستخدمين جدد. الـ Rules أصلاً بتمنع أي إيميل غير المحدد، لكن الأحسن تقفل sign-up من Authentication → Settings → User actions.
- الـ Collection اسمه `agencies` والحقول: `ar`, `en`, `id`, `createdAt`.
