/**
 * Halaman login admin — Dashboard Kunjungan Pasien Puskesmas Bulusan.
 *
 * Halaman ini berdiri sendiri dan tidak memuat app.js. Setelah login
 * berhasil, pengguna diarahkan kembali ke dashboard (index.html).
 */

import { CONFIG } from './config.js';
import {
  initDataLayer,
  getMode,
  isAuthenticated,
  signIn,
} from './supabase-client.js';

const $ = (selector, root = document) => root.querySelector(selector);

const form = $('#login-form');
const emailInput = $('#login-email');
const passwordInput = $('#login-password');
const errorBox = $('#login-error');
const submitButton = $('#btn-login-submit');
const demoHint = $('#demo-hint');
const authCard = $('.auth-card');
const authStatus = $('#auth-status');
const togglePassword = $('#btn-toggle-password');
const fillDemo = $('#btn-fill-demo');
const yearLabel = $('#auth-year');

let submitting = false;

/* -------------------------------------------------------------------------- */
/* Utilitas                                                                   */
/* -------------------------------------------------------------------------- */

function setYear() {
  if (yearLabel) yearLabel.textContent = String(new Date().getFullYear());
}

function resolveNextUrl() {
  const raw = new URLSearchParams(window.location.search).get('next');
  if (!raw) return 'index.html';

  try {
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin) return 'index.html';
    if (/\/(login(\.html)?|login\/)$/i.test(url.pathname)) return 'index.html';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return 'index.html';
  }
}

function goToDashboard() {
  window.location.replace(resolveNextUrl());
}

function clearError() {
  if (!errorBox) return;
  errorBox.textContent = '';
  errorBox.classList.add('hidden');
}

function showError(message) {
  if (!errorBox) return;
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
}

function setLoading(loading, label = 'Memeriksa…') {
  if (!submitButton) return;

  if (loading) {
    if (!submitButton.dataset.originalHtml) {
      submitButton.dataset.originalHtml = submitButton.innerHTML;
    }
    submitButton.disabled = true;
    submitButton.innerHTML = `<span class="spinner spinner-light"></span>${label}`;
  } else {
    if (submitButton.dataset.originalHtml) {
      submitButton.innerHTML = submitButton.dataset.originalHtml;
      delete submitButton.dataset.originalHtml;
    }
    submitButton.disabled = false;
  }
}

function finishBoot() {
  authCard?.classList.remove('is-booting');
  authStatus?.classList.add('hidden');
}

/* -------------------------------------------------------------------------- */
/* Interaksi form                                                             */
/* -------------------------------------------------------------------------- */

function bindPasswordToggle() {
  if (!togglePassword || !passwordInput) return;

  togglePassword.addEventListener('click', () => {
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    togglePassword
      .querySelector('use')
      ?.setAttribute('href', show ? '#i-eye-off' : '#i-eye');
    togglePassword.setAttribute(
      'aria-label',
      show ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'
    );
  });
}

function bindDemoFill() {
  if (!fillDemo) return;

  fillDemo.addEventListener('click', () => {
    if (emailInput) emailInput.value = CONFIG.demoAdmin.email;
    if (passwordInput) passwordInput.value = CONFIG.demoAdmin.password;
    emailInput?.focus();
  });
}

function bindSubmit() {
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;

    clearError();

    const email = emailInput?.value.trim() || '';
    const password = passwordInput?.value || '';

    if (!email || !password) {
      showError('Email dan kata sandi wajib diisi.');
      (email ? passwordInput : emailInput)?.focus();
      return;
    }

    submitting = true;
    setLoading(true, 'Memeriksa…');

    try {
      await signIn(email, password);
      setLoading(true, 'Berhasil…');
      goToDashboard();
    } catch (error) {
      showError(
        error?.message || 'Login gagal. Periksa email dan kata sandi Anda.'
      );
      setLoading(false);
      submitting = false;
      passwordInput?.focus();
      passwordInput?.select();
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Inisialisasi halaman                                                       */
/* -------------------------------------------------------------------------- */

async function boot() {
  setYear();
  bindPasswordToggle();
  bindDemoFill();
  bindSubmit();

  try {
    await initDataLayer();
  } catch (error) {
    console.error('Gagal inisialisasi lapisan data:', error);
  }

  if (isAuthenticated()) {
    goToDashboard();
    return;
  }

  const demoMode = getMode() === 'demo';
  demoHint?.classList.toggle('hidden', !demoMode);
  finishBoot();
  emailInput?.focus();
}

boot();
