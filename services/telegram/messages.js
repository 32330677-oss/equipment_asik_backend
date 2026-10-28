// services/telegram/messages.js — every text the bot sends, Arabic (default) and English.
const T = {
  ar: {
    welcome: 'أهلاً {name} 👋\nتم ربط حسابك ببوت الآليات.',
    moved: 'تم نقل ربط حسابك لمحادثة تانية. هالمحادثة ما عاد مربوطة.',
    unlinked_by_admin: 'تم فك ربط هالمحادثة بحسابك بالآليات.',
    link_invalid: 'رابط الربط غلط أو انتهت صلاحيته (15 دقيقة).\nافتح تطبيق الآليات ← القائمة ← «اربط تيلغرام» واكبس الرابط الجديد.',
    not_eligible: 'هالحساب ما بيقدر يستعمل البوت. البوت لمشرفي المواقع بحساب فعّال بس.',
    not_linked: 'هالمحادثة مو مربوطة بحساب.\nافتح تطبيق الآليات ← القائمة ← «اربط تيلغرام».',
    account_inactive: 'حسابك موقوف أو ما عاد مشرف، فالبوت ما بيشتغل. راجع الإدارة.',
    change_password: 'لازم تغيّر كلمة السر بالتطبيق أول، وبعدها رجاع ابعتلي.',
    private_only: 'استعمل البوت بمحادثة خاصة معه بس.',
    bot_off: 'البوت متوقف مؤقتاً. سجّل من التطبيق.',
    lang_set: 'تمام، رح احكي معك بالعربي.',
    today_title: '📋 <b>وضع آلياتك اليوم</b> ({date})',
    no_sites: 'ما عندك مواقع اليوم بحسب توزيع المشرفين.',
    site_line: '📍 <b>{site}</b> · {shift}',
    machines: '{n} آلية',
    site_error: 'ما قدرت جيب وضع هالموقع هلق: {why}',
    server_error: 'ما قدرت جيب البيانات هلق ({why}). جرّب بعد شوي.',
    coming_soon: 'ℹ️ هلق البوت بيعرض الوضع بس. التسجيل بالكلام والفويس جاي بالتحديث الجاي، ولحد وقتها سجّل من التطبيق.',
    shift_Day: 'نهاري', shift_Night: 'ليلي',
    st_working: 'شغّالة', st_on_break: 'باستراحة', st_breakdown: 'معطّلة', st_standby: 'Standby',
    st_not_arrived: 'بدون سجل', st_finished: 'خلصت', st_absent: 'غايبة', st_holiday: 'عطلة',
  },
  en: {
    welcome: 'Hello {name} 👋\nYour account is now linked to the equipment bot.',
    moved: 'Your account was linked to another chat. This chat is no longer linked.',
    unlinked_by_admin: 'This chat was unlinked from your equipment account.',
    link_invalid: 'This link is wrong or has expired (15 minutes).\nOpen the equipment app → menu → "Link Telegram" and tap the new link.',
    not_eligible: 'This account cannot use the bot. It is for active site supervisors only.',
    not_linked: 'This chat is not linked to an account.\nOpen the equipment app → menu → "Link Telegram".',
    account_inactive: 'Your account is inactive or no longer a supervisor, so the bot is off for you. Contact the office.',
    change_password: 'Please change your password in the app first, then message me again.',
    private_only: 'Please use the bot in a private chat only.',
    bot_off: 'The bot is paused. Please record in the app.',
    lang_set: 'OK, I will talk to you in English.',
    today_title: '📋 <b>Your machines today</b> ({date})',
    no_sites: 'You have no sites today in the supervisor schedule.',
    site_line: '📍 <b>{site}</b> · {shift}',
    machines: '{n} machine(s)',
    site_error: 'Could not load this site now: {why}',
    server_error: 'Could not load the data now ({why}). Please try again shortly.',
    coming_soon: 'ℹ️ For now the bot shows the status only. Recording by text and voice comes in the next update; until then please record in the app.',
    shift_Day: 'Day', shift_Night: 'Night',
    st_working: 'working', st_on_break: 'on break', st_breakdown: 'breakdown', st_standby: 'standby',
    st_not_arrived: 'no record', st_finished: 'finished', st_absent: 'absent', st_holiday: 'holiday',
  },
};

function t(lang, key, vars = {}) {
  const table = T[lang] || T.ar;
  const s = table[key] !== undefined ? table[key] : T.ar[key] !== undefined ? T.ar[key] : key;
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

module.exports = { t, T };
