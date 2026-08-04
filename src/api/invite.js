import { createReset, RESET_TTL_MS } from '../db/sessions.js';
import { emailButton, emailShell, escapeEmailHtml } from '../email.js';

const ROLE_LABELS = {
  super_admin: 'Super Admin',
  general_admin: 'General Admin',
  cashier: 'Cashier'
};

/**
 * Deliver a single-use password-creation link for a staff account.
 * The raw token only exists long enough to put it in the email. Supabase stores
 * its SHA-256 digest, so a database read cannot be turned into an invitation.
 */
export async function sendAccountInvite(env, account, origin, inviter, dependencies = {}) {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
    return { sent: false, status: 503, error: 'Email is not configured on this deployment.' };
  }
  if (!account?.id || !account?.email || account.active === false) {
    return { sent: false, status: 400, error: 'Only an active staff account can be invited.' };
  }

  const createToken = dependencies.createReset || createReset;
  const deliver = dependencies.fetch || fetch;
  const reset = await createToken(env, account.id);
  if (reset.error || !reset.data?.token) {
    console.error('account invite: token create failed — ' + (reset.error?.code || 'unknown'));
    return { sent: false, status: 503, error: 'The invitation link could not be created.' };
  }

  const link = new URL('/login/reset', origin);
  link.searchParams.set('token', reset.data.token);
  link.searchParams.set('invite', '1');

  const minutes = Math.round(RESET_TTL_MS / 60000);
  const name = account.display_name || account.email;
  const role = ROLE_LABELS[account.role] || 'Staff';
  const invitedBy = inviter?.display_name || inviter?.email || 'A Verre administrator';
  const text = [
    'Hi ' + name + ',',
    '',
    invitedBy + ' invited you to the Verre workroom as ' + role + '.',
    '',
    'Create your password here:',
    link.toString(),
    '',
    'This secure link works once and expires in ' + minutes + ' minutes.',
    'After creating your password, use your email address to sign in.',
    '',
    'If you were not expecting this invitation, you can ignore this email.',
    '',
    '— Verre'
  ].join('\n');
  const html = emailShell({
    preheader: invitedBy + ' invited you to the Verre workroom.',
    eyebrow: 'You’re invited',
    title: 'Welcome to the workroom',
    intro: 'Hi ' + escapeEmailHtml(name) + ' — ' + escapeEmailHtml(invitedBy) + ' invited you to help with Verre.',
    body:
      '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#FFF8F3;border-radius:16px;margin:0 0 20px"><tr><td style="padding:18px">' +
      '<span style="color:#9A6D82;display:block;font-size:11px;font-weight:700;letter-spacing:.14em;margin-bottom:5px;text-transform:uppercase">Your role</span>' +
      '<strong style="display:block;font-family:Georgia,serif;font-size:21px">' + escapeEmailHtml(role) + '</strong>' +
      '</td></tr></table>' +
      '<p style="margin:0 0 10px;text-align:center">Create your password, then sign in with <strong>' + escapeEmailHtml(account.email) + '</strong>.</p>' +
      '<p style="color:#7A5C6B;font-size:13px;margin:0;text-align:center">This private link works once and expires in ' + minutes + ' minutes.</p>',
    action: emailButton('Create my password', link.toString()),
    footer: 'If you were not expecting this invitation, you can safely ignore it.'
  });

  try {
    const response = await deliver('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + env.RESEND_API_KEY,
        'content-type': 'application/json',
        'user-agent': 'verrewebsite/1.0'
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: account.email,
        subject: 'You’re invited to the Verre workroom',
        text,
        html
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      console.error('account invite: resend failed — ' + response.status);
      return { sent: false, status: 502, error: 'The account was saved, but its invitation email was not delivered.' };
    }
    return { sent: true, status: 200 };
  } catch (error) {
    console.error('account invite: delivery failed — ' + (error?.name || 'unknown'));
    return { sent: false, status: 502, error: 'The account was saved, but its invitation email was not delivered.' };
  }
}

export const _test = { ROLE_LABELS };
