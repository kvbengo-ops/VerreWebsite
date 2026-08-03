const $ = (s) => document.querySelector(s);

// Same rule the Worker applies to return_to. Kept identical on purpose: this
// value reaches location.assign(), so 'https://evil.com' or '//evil.com' would
// be an open redirect straight off the sign-in page.
const safeReturn = (raw) => {
  const value = String(raw || '/admin');
  return value.startsWith('/') && !value.startsWith('//') ? value : '/admin';
};

const params = new URLSearchParams(location.search);
const returnTo = safeReturn(params.get('return_to'));
const resetToken = params.get('token');
const isInvite = params.get('invite') === '1';

function show(name) {
  for (const view of ['login', 'forgot', 'reset']) {
    $('#view-' + view).hidden = view !== name;
  }
  const first = $('#view-' + name).querySelector('input');
  if (first) first.focus();
}

function alertBox(id, message, good = false) {
  const el = $(id);
  if (!message) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle('good', good);
  // Move focus to the message so a screen reader announces it and a keyboard
  // user is not left wondering why nothing happened.
  el.setAttribute('tabindex', '-1');
  el.focus();
}

async function post(path, payload) {
  const response = await fetch('/api/auth/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    throw new Error('The server returned an unreadable response. Please try again.');
  }
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'Something went wrong.');
  return data.data || {};
}

/**
 * Guards every form: disables the button, swaps the label, and — importantly —
 * leaves the typed values alone on failure. Retyping a password because the
 * network blipped is a small thing that feels like a broken product.
 */
function submitting(form, label) {
  const button = form.querySelector('button[type="submit"]');
  const original = button.textContent;
  let done = false;
  button.disabled = true;
  button.textContent = label;
  return () => {
    if (done) return;
    done = true;
    button.disabled = false;
    button.textContent = original;
  };
}

/* ---------------------------------------------------------------- */

$('#to-forgot').onclick = (e) => { e.preventDefault(); alertBox('#forgot-alert', null); show('forgot'); };
$('#to-login').onclick = (e) => { e.preventDefault(); alertBox('#login-alert', null); show('login'); };

$('#form-login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const email = form.email.value.trim();
  const password = form.password.value;
  alertBox('#login-alert', null);

  if (!email || !password) {
    alertBox('#login-alert', 'Please fill in both fields.');
    (email ? form.password : form.email).focus();
    return;
  }

  const restore = submitting(form, 'Signing in…');
  try {
    await post('login', { email, password });
    location.assign(returnTo);
  } catch (error) {
    restore();
    alertBox('#login-alert', error.message);
    form.password.value = '';
    form.password.focus();
  }
});

$('#form-forgot').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  alertBox('#forgot-alert', null);
  const restore = submitting(form, 'Sending…');
  try {
    const data = await post('request-reset', { email: form.email.value.trim() });
    // Deliberately says nothing about whether that address exists.
    alertBox('#forgot-alert', data.message || 'If that email has an account, a reset link is on its way.', true);
    form.reset();
  } catch (error) {
    alertBox('#forgot-alert', error.message);
  } finally {
    restore();
  }
});

$('#form-reset').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const password = form.password.value;
  alertBox('#reset-alert', null);

  if (password !== form.confirm.value) {
    alertBox('#reset-alert', 'Those two passwords do not match.');
    form.confirm.focus();
    return;
  }
  if (password.length < 12) {
    alertBox('#reset-alert', 'Use at least 12 characters.');
    form.password.focus();
    return;
  }

  const restore = submitting(form, 'Saving…');
  try {
    await post('reset', { token: resetToken, password });
    alertBox('#reset-alert', (isInvite ? 'Password created.' : 'Password updated.') + ' Taking you to sign in…', true);
    setTimeout(() => location.assign('/login'), 1400);
  } catch (error) {
    restore();
    alertBox('#reset-alert', error.message);
  }
});

// /login/reset?token=… lands straight on the new-password form.
if (resetToken && location.pathname.startsWith('/login/reset')) {
  if (isInvite) {
    $('#reset-title').textContent = 'Create your password';
    $('#reset-copy').textContent = 'You’re joining the Verre workroom. Choose a long, private password.';
    $('#reset-submit').textContent = 'Create password';
  }
  show('reset');
} else {
  show('login');
}
