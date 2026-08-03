const COLORS = {
  ink: '#3A2430',
  body: '#6F5662',
  pink: '#F157A8',
  blush: '#FFF0F7',
  cream: '#FFF8F3',
  red: '#EF4056',
  yellow: '#FFD166'
};

export const escapeEmailHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

export function emailButton(label, href) {
  return '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:26px auto 8px"><tr><td>' +
    '<a href="' + escapeEmailHtml(href) + '" style="display:inline-block;background:' + COLORS.pink +
    ';border:2px solid ' + COLORS.pink + ';border-radius:999px;color:#ffffff;font-family:Arial,sans-serif;' +
    'font-size:15px;font-weight:700;letter-spacing:.01em;line-height:20px;padding:13px 28px;text-decoration:none">' +
    escapeEmailHtml(label) + '</a></td></tr></table>';
}

export function emailReference(ref) {
  return '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:22px 0">' +
    '<tr><td style="background:' + COLORS.blush + ';border:1px solid #FFD2E6;border-radius:16px;padding:15px 18px;text-align:center">' +
    '<span style="color:#9A6D82;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase">Reference</span><br>' +
    '<strong style="color:' + COLORS.ink + ';font-family:Arial,sans-serif;font-size:19px;letter-spacing:.08em">' +
    escapeEmailHtml(ref) + '</strong></td></tr></table>';
}

export function emailMessage(message) {
  if (!message) return '';
  return '<div style="background:' + COLORS.cream + ';border-left:4px solid ' + COLORS.yellow +
    ';border-radius:4px 14px 14px 4px;color:' + COLORS.body +
    ';font-family:Arial,sans-serif;font-size:14px;line-height:1.65;margin:20px 0;padding:14px 16px;white-space:pre-wrap">' +
    escapeEmailHtml(message) + '</div>';
}

export function emailShell({ preheader, eyebrow, title, intro = '', body = '', action = '', footer = '' }) {
  const hidden = escapeEmailHtml(preheader || title);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="x-apple-disable-message-reformatting"><title>' + escapeEmailHtml(title) + '</title>' +
    '<style>@media only screen and (max-width:620px){.email-wrap{padding:18px 10px!important}.email-card{padding:28px 20px!important}.email-title{font-size:28px!important}.email-detail td{display:block!important;width:100%!important;text-align:left!important;padding:4px 0!important}}</style>' +
    '</head><body style="background:' + COLORS.cream + ';margin:0;padding:0;width:100%">' +
    '<div style="display:none;font-size:1px;color:' + COLORS.cream + ';line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">' + hidden + '</div>' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:' + COLORS.cream + '"><tr><td class="email-wrap" align="center" style="padding:38px 16px">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px">' +
    '<tr><td style="padding:0 0 16px;text-align:center">' +
    '<span style="display:inline-block;background:linear-gradient(145deg,#FF8FC5,' + COLORS.pink + ');border-radius:50%;color:#fff;font-family:Georgia,serif;font-size:25px;font-style:italic;font-weight:700;height:48px;line-height:48px;text-align:center;width:48px">V</span>' +
    '<div style="color:' + COLORS.red + ';font-family:Georgia,serif;font-size:22px;font-style:italic;font-weight:700;margin-top:8px">Verre</div>' +
    '</td></tr><tr><td class="email-card" style="background:#ffffff;border:1px solid #FFD9EA;border-radius:28px;box-shadow:0 12px 0 rgba(239,64,86,.08);padding:38px 42px">' +
    '<div style="text-align:center"><span style="display:inline-block;background:' + COLORS.yellow + ';border-radius:999px;color:#6A4520;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:.18em;padding:7px 12px;text-transform:uppercase">' +
    escapeEmailHtml(eyebrow) + '</span>' +
    '<h1 class="email-title" style="color:' + COLORS.ink + ';font-family:Georgia,serif;font-size:34px;font-style:italic;line-height:1.15;margin:18px 0 12px">' +
    escapeEmailHtml(title) + '</h1>' +
    (intro ? '<p style="color:' + COLORS.body + ';font-family:Arial,sans-serif;font-size:15px;line-height:1.65;margin:0 0 24px">' + intro + '</p>' : '') +
    '</div><div style="color:' + COLORS.ink + ';font-family:Arial,sans-serif;font-size:14px;line-height:1.65">' + body + action + '</div>' +
    '</td></tr><tr><td style="color:#9A7B89;font-family:Arial,sans-serif;font-size:11px;line-height:1.6;padding:26px 24px 0;text-align:center">' +
    (footer || 'Made by hand in Cebu City.') + '<br><span style="color:' + COLORS.pink + '">✦</span> Verre handmade crafts</td></tr>' +
    '</table></td></tr></table></body></html>';
}
