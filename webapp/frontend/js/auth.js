import { setToken } from './api.js';

let signedInCallback = null;

export function initGoogleSignIn(clientId, onSignedIn) {
  if (!clientId || !window.google || !window.google.accounts) return false;
  signedInCallback = onSignedIn;
  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: handleCredentialResponse,
  });
  return true;
}

export function renderSignInButton(container) {
  window.google.accounts.id.renderButton(container, {
    theme: 'outline',
    size: 'large',
    text: 'signin_with',
    width: 280,
  });
}

async function handleCredentialResponse(response) {
  setToken(response.credential);
  if (signedInCallback) await signedInCallback();
}

export function signOut() {
  setToken('');
  if (window.google && window.google.accounts && window.google.accounts.id) {
    window.google.accounts.id.disableAutoSelect();
  }
}
