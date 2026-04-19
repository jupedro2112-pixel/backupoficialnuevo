// ========================================
// AUTH - Authentication module
// ========================================

window.VIP = window.VIP || {};

VIP.auth = (function () {

    function escapeHtml(text) {
        if (!text && text !== 0) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }

    /**
     * Muestra el banner de fallback OTP en el elemento con id `targetId`.
     * El banner es prominente (fondo amarillo/naranja, borde rojo) para que
     * el usuario note que el SMS no llegó y que el código es sensible.
     * NO auto-rellena el campo de código para evitar visual spoofing.
     * Usa DOM methods (sin innerHTML) para prevenir XSS.
     *
     * @param {string} targetId   - id del elemento donde insertar el banner
     * @param {object} fallback   - { code, reason, warning } de la respuesta API
     * @param {string} maskedPhone - Teléfono enmascarado de la respuesta API
     */
    function _showOtpFallbackBanner(targetId, fallback, maskedPhone) {
        const container = document.getElementById(targetId);
        if (!container) return;

        // Limpiar contenido anterior con DOM seguro
        while (container.firstChild) { container.removeChild(container.firstChild); }

        const banner = document.createElement('div');
        banner.className = 'otp-fallback-banner';

        const warningP = document.createElement('p');
        warningP.className = 'otp-fallback-warning';
        warningP.textContent = fallback.warning || '';
        banner.appendChild(warningP);

        const codeWrap = document.createElement('div');
        codeWrap.className = 'otp-fallback-code-wrap';

        const codeEl = document.createElement('span');
        codeEl.className = 'otp-fallback-code';
        codeEl.textContent = fallback.code || '';
        codeWrap.appendChild(codeEl);

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn otp-fallback-copy-btn';
        copyBtn.textContent = '📋 Copiar código';
        codeWrap.appendChild(copyBtn);

        banner.appendChild(codeWrap);

        const maskedEl = document.createElement('small');
        maskedEl.style.cssText = 'color:#555; display:block; margin-top:8px;';
        maskedEl.textContent = 'Teléfono: ' + (maskedPhone || '');
        banner.appendChild(maskedEl);

        container.appendChild(banner);

        copyBtn.addEventListener('click', function () {
            const code = codeEl.textContent;
            if (!code) return;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(code).then(function () {
                    copyBtn.textContent = '✅ Copiado';
                    setTimeout(function () { copyBtn.textContent = '📋 Copiar código'; }, 2000);
                }).catch(function () {});
            } else {
                // execCommand('copy') está deprecado pero se usa como último recurso
                // para browsers sin Clipboard API (ej: algunos WebViews de iOS/Android viejos).
                try {
                    var ta = document.createElement('textarea');
                    ta.value = code;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    copyBtn.textContent = '✅ Copiado';
                    setTimeout(function () { copyBtn.textContent = '📋 Copiar código'; }, 2000);
                } catch (e) {}
            }
        });
    }

    async function checkUsernameAvailability(username) {
        const resultSpan = document.getElementById('usernameCheckResult');
        try {
            const response = await fetch(
                `${VIP.config.API_URL}/api/auth/check-username?username=${encodeURIComponent(username)}`
            );
            const data = await response.json();
            if (data.available) {
                resultSpan.textContent = '✅ Usuario disponible';
                resultSpan.style.color = '#00ff88';
            } else {
                resultSpan.textContent = '❌ ' + (data.message || 'Usuario no disponible');
                resultSpan.style.color = '#ff4444';
            }
        } catch (error) {
            resultSpan.textContent = '';
        }
    }

    // Estado temporal del registro OTP (compartido con app.js global via window)
    let _vipRegisterOtpPhone = null;

    async function handleRegister(e) {
        if (e) e.preventDefault();
        // El registro ahora usa flujo OTP: handleRegisterSendOtp y handleRegisterWithOtp
        // Esta función se mantiene por compatibilidad
    }

    async function handleRegisterSendOtp() {
        const username = document.getElementById('registerUsername').value.trim();
        const password = document.getElementById('registerPassword').value;
        const passwordConfirm = document.getElementById('registerPasswordConfirm').value;
        const phonePrefix = document.getElementById('registerPhonePrefix').value;
        const phoneNumber = document.getElementById('registerPhone').value.trim();
        const errorDiv = document.getElementById('registerError');

        errorDiv.classList.remove('show');

        if (password !== passwordConfirm) {
            errorDiv.textContent = 'Las contraseñas no coinciden';
            errorDiv.classList.add('show');
            return;
        }
        if (password.length < 6) {
            errorDiv.textContent = 'La contraseña debe tener al menos 6 caracteres';
            errorDiv.classList.add('show');
            return;
        }
        if (username.length < 3) {
            errorDiv.textContent = 'El usuario debe tener al menos 3 caracteres';
            errorDiv.classList.add('show');
            return;
        }
        if (!phoneNumber || phoneNumber.replace(/\D/g, '').length < 8) {
            errorDiv.textContent = 'Ingresá un número de teléfono válido (mínimo 8 dígitos)';
            errorDiv.classList.add('show');
            return;
        }

        const fullPhone = phonePrefix + phoneNumber.replace(/[\s\-().]/g, '');
        const btn = document.getElementById('registerSendOtpBtn');
        if (btn) { btn.textContent = 'Enviando...'; btn.disabled = true; }

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/send-register-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: fullPhone, username })
            });
            const data = await response.json();

            if (response.ok && data.success) {
                _vipRegisterOtpPhone = fullPhone;
                // Sync con variable global si existe (app.js)
                if (typeof window !== 'undefined') window._registerOtpPhone = fullPhone;
                document.getElementById('registerStep1').style.display = 'none';
                document.getElementById('registerStep2').style.display = '';
                document.getElementById('registerOtpCode').value = '';
                document.getElementById('registerOtpError').classList.remove('show');

                if (data.fallback) {
                    console.warn('[OTP Fallback] SMS no enviado. Mostrando código alternativo en pantalla.', data.fallback.reason);
                    _showOtpFallbackBanner('registerOtpMsg', data.fallback, data.phone);
                } else {
                    document.getElementById('registerOtpMsg').textContent = `✅ ${data.message} (${data.phone})`;
                }
            } else {
                errorDiv.textContent = data.error || 'Error al enviar el código SMS';
                errorDiv.classList.add('show');
            }
        } catch (error) {
            errorDiv.textContent = 'Error de conexión. Intenta más tarde.';
            errorDiv.classList.add('show');
        } finally {
            if (btn) { btn.textContent = '📱 Enviar código SMS'; btn.disabled = false; }
        }
    }

    async function handleRegisterWithOtp() {
        const username = document.getElementById('registerUsername').value.trim();
        const password = document.getElementById('registerPassword').value;
        const email = document.getElementById('registerEmail').value.trim();
        const referralCodeInput = document.getElementById('registerReferralCode');
        const referralCode = referralCodeInput ? referralCodeInput.value.trim().toUpperCase() : null;
        const otpCode = document.getElementById('registerOtpCode').value.trim();
        const errorDiv = document.getElementById('registerOtpError');
        const submitBtn = document.getElementById('registerSubmitBtn');

        errorDiv.classList.remove('show');

        if (!otpCode || otpCode.length < 6) {
            errorDiv.textContent = 'Ingresá el código de 6 dígitos';
            errorDiv.classList.add('show');
            return;
        }

        const phone = _vipRegisterOtpPhone || (typeof window !== 'undefined' ? window._registerOtpPhone : null);
        if (!phone) {
            errorDiv.textContent = 'Error: teléfono no encontrado. Volvé al paso anterior.';
            errorDiv.classList.add('show');
            return;
        }

        if (submitBtn) { submitBtn.textContent = 'Creando cuenta...'; submitBtn.disabled = true; }

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username,
                    password,
                    email: email || null,
                    phone,
                    referralCode: referralCode || undefined,
                    otpCode
                })
            });
            const data = await response.json();

            if (response.ok) {
                _vipRegisterOtpPhone = null;
                if (typeof window !== 'undefined') window._registerOtpPhone = null;
                VIP.state.currentToken = data.token;
                VIP.state.currentUser = { ...data.user, id: data.user.id, userId: data.user.id };
                localStorage.setItem('userToken', VIP.state.currentToken);

                VIP.ui.hideModal('registerModal');
                document.getElementById('registerForm').reset();
                document.getElementById('usernameCheckResult').textContent = '';
                document.getElementById('registerStep1').style.display = '';
                document.getElementById('registerStep2').style.display = 'none';

                await initializeSession(true);
                console.log('[FCM] Registro exitoso, enviando token FCM...');
                await VIP.notifications.sendFcmTokenAfterLogin();
                VIP.ui.showToast('✅ ¡Cuenta creada exitosamente!', 'success');
            } else {
                errorDiv.textContent = data.error || 'Error al crear cuenta';
                errorDiv.classList.add('show');
            }
        } catch (error) {
            errorDiv.textContent = 'Error de conexión';
            errorDiv.classList.add('show');
        } finally {
            if (submitBtn) { submitBtn.textContent = '📝 Crear Cuenta'; submitBtn.disabled = false; }
        }
    }

    async function handleLogin(e) {
        e.preventDefault();

        const loginMode = window._loginMode || 'username';
        const username = loginMode === 'username' ? document.getElementById('username').value : null;
        const phonePrefix = loginMode === 'phone' ? (document.getElementById('loginPhonePrefix')?.value || '+54') : null;
        const phoneNumber = loginMode === 'phone' ? document.getElementById('loginPhone')?.value?.trim() : null;
        const phone = loginMode === 'phone' ? (phonePrefix + (phoneNumber || '').replace(/\D/g, '')) : null;
        const password = document.getElementById('password').value;
        const errorDiv = document.getElementById('errorMessage');
        const loginBtn = document.querySelector('#loginForm button[type="submit"]');

        if (loginMode === 'phone' && (!phoneNumber || phoneNumber.replace(/\D/g, '').length < 7)) {
            errorDiv.textContent = 'Ingresá un número de celular válido';
            errorDiv.classList.add('show');
            return;
        }

        if (loginMode === 'username' && !username) {
            errorDiv.textContent = 'Ingresá tu usuario';
            errorDiv.classList.add('show');
            return;
        }

        if (loginBtn) { loginBtn.textContent = 'Ingresando...'; loginBtn.disabled = true; }
        errorDiv.classList.remove('show');

        const loginTimeout = setTimeout(() => {
            errorDiv.textContent = 'Tiempo de espera agotado. Intenta nuevamente.';
            errorDiv.classList.add('show');
            if (loginBtn) { loginBtn.textContent = 'Ingresar a la Sala'; loginBtn.disabled = false; }
        }, 15000);

        try {
            // OTP login flow for phone mode
            if (loginMode === 'phone' && window._phoneLoginMode === 'otp') {
                const response = await fetch(`${VIP.config.API_URL}/api/auth/login-otp-request`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone })
                });
                const data = await response.json();
                if (response.ok && data.success) {
                    window._phoneOtpFullPhone = phone;
                    document.getElementById('phoneOtpMsg').textContent = `✅ ${data.message}`;
                    document.getElementById('phoneOtpStep').classList.remove('hidden');
                    document.getElementById('phoneOtpCode').value = '';
                    if (loginBtn) loginBtn.style.display = 'none';
                } else {
                    errorDiv.textContent = data.error || 'Error al enviar código';
                    errorDiv.classList.add('show');
                }
                clearTimeout(loginTimeout);
                if (loginBtn) { loginBtn.textContent = '📱 Enviar código SMS'; loginBtn.disabled = false; }
                return;
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            const loginPayload = loginMode === 'phone'
                ? { phone, password }
                : { username, password };

            const response = await fetch(`${VIP.config.API_URL}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(loginPayload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            clearTimeout(loginTimeout);

            const data = await response.json();

            if (response.ok) {
                VIP.state.currentToken = data.token;
                VIP.state.currentUser = { ...data.user, id: data.user.id, userId: data.user.id };
                localStorage.setItem('userToken', VIP.state.currentToken);

                // Guardar contraseña en memoria de sesión para mostrarla en el modal de plataforma
                VIP.state.sessionPassword = password;

                // Guardar token de JUGAYGANA en sessionStorage (expira al cerrar el navegador)
                if (data.jugayganaToken) {
                    VIP.state.jugayganaToken = data.jugayganaToken;
                    sessionStorage.setItem('jugayganaToken', data.jugayganaToken);
                } else {
                    VIP.state.jugayganaToken = null;
                    sessionStorage.removeItem('jugayganaToken');
                }

                try {
                    await initializeSession(false);
                } catch (initError) {
                    console.error('Error inicializando sesión:', initError);
                }

                if (data.user.needsPasswordChange || data.user.mustChangePassword === true) {
                    VIP.state.passwordChangePending = true;
                    prepareChangePasswordModal();
                    VIP.ui.showModal('changePasswordModal');
                }

                VIP.notifications.requestNotificationPermission();
                VIP.notifications.sendFcmTokenAfterLogin();
            } else {
                errorDiv.textContent = data.error || 'Error de autenticación';
                errorDiv.classList.add('show');
            }
        } catch (error) {
            clearTimeout(loginTimeout);
            if (error.name === 'AbortError') {
                errorDiv.textContent = 'La conexión tardó demasiado. Intenta nuevamente.';
            } else {
                errorDiv.textContent = 'Error de conexión';
            }
            errorDiv.classList.add('show');
        } finally {
            if (loginBtn) {
                loginBtn.textContent = window._phoneLoginMode === 'otp' && loginMode === 'phone' ? '📱 Enviar código SMS' : 'Ingresar a la Sala';
                loginBtn.disabled = false;
            }
        }
    }

    async function verifyToken() {
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/verify`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });

            if (response.ok) {
                const data = await response.json();

                if (!data.user || !data.user.username) {
                    console.log('Token válido pero falta información de usuario, recargando...');
                    const userResponse = await fetch(`${VIP.config.API_URL}/api/users/me`, {
                        headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
                    });
                    if (userResponse.ok) {
                        const userData = await userResponse.json();
                        VIP.state.currentUser = {
                            ...userData,
                            id: userData.id || userData.userId,
                            userId: userData.userId || userData.id
                        };
                    } else {
                        VIP.state.currentUser = {
                            ...data.user,
                            id: data.user.id || data.user.userId,
                            userId: data.user.userId || data.user.id
                        };
                    }
                } else {
                    VIP.state.currentUser = {
                        ...data.user,
                        id: data.user.id || data.user.userId,
                        userId: data.user.userId || data.user.id
                    };
                }

                VIP.ui.showChatScreen();
                VIP.socket.startMessagePolling();
                VIP.refunds.loadRefundStatus();
                VIP.fire.loadFireStatus();

                // Server-side enforcement: if the user must change their
                // password (flag persisted in DB), re-open the mandatory
                // change modal even after a page reload.
                if (VIP.state.currentUser && VIP.state.currentUser.mustChangePassword === true) {
                    VIP.state.passwordChangePending = true;
                    try { prepareChangePasswordModal(); } catch (e) { /* DOM not ready */ }
                    try { VIP.ui.showModal('changePasswordModal'); } catch (e) { /* ignore */ }
                }

                VIP.notifications.requestNotificationPermission();
                VIP.notifications.sendFcmTokenAfterLogin().catch(function (e) {
                    console.warn('[FCM] Error al re-sincronizar token en verifyToken:', e);
                });
            } else {
                localStorage.removeItem('userToken');
            }
        } catch (error) {
            console.error('Error verificando token:', error);
            localStorage.removeItem('userToken');
        }
    }

    function handleLogout() {
        VIP.socket.stopMessagePolling();
        VIP.ui.stopBalancePolling();
        VIP.state.currentToken = null;
        VIP.state.currentUser = null;
        VIP.state.sessionPassword = '';
        localStorage.removeItem('userToken');
        sessionStorage.removeItem('sessionPassword');
        VIP.ui.showLoginScreen();
    }

    async function ensureUserLoaded(retries = 3) {
        if (VIP.state.currentUser && VIP.state.currentUser.id && VIP.state.currentUser.username) {
            console.log('✅ Usuario ya cargado completamente:', VIP.state.currentUser.username);
            return true;
        }

        console.log('🔄 Cargando usuario automáticamente...');

        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(`${VIP.config.API_URL}/api/users/me`, {
                    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
                });

                if (response.ok) {
                    const userData = await response.json();
                    if (userData && userData.username) {
                        VIP.state.currentUser = {
                            ...userData,
                            id: userData.id || userData._id,
                            userId: userData.id || userData._id
                        };
                        console.log('✅ Usuario cargado exitosamente:', VIP.state.currentUser.username);
                        return true;
                    }
                } else if (response.status === 404) {
                    console.log(`⏳ Intento ${i + 1}/${retries}: Usuario no encontrado, reintentando...`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                } else {
                    console.error('Error cargando usuario:', response.status);
                }
            } catch (error) {
                console.error('Error en ensureUserLoaded:', error);
            }
        }

        console.error('❌ No se pudo cargar el usuario después de', retries, 'intentos');
        return false;
    }

    async function initializeSession(afterRegister = false) {
        console.log('🚀 Inicializando sesión...');

        const userLoaded = await ensureUserLoaded(afterRegister ? 5 : 3);

        if (!userLoaded) {
            console.warn('⚠️ No se pudo cargar el usuario completamente, pero continuando...');
        }

        // Server-side enforcement of mandatory password change.
        // If `/api/users/me` reported `mustChangePassword: true`, re-open the
        // mandatory change modal automatically. This handles the page-reload
        // bypass: the flag lives on the server and is detected here on every
        // session bootstrap.
        if (VIP.state.currentUser && VIP.state.currentUser.mustChangePassword === true) {
            VIP.state.passwordChangePending = true;
            try { prepareChangePasswordModal(); } catch (e) { /* DOM not ready yet */ }
            try { VIP.ui.showModal('changePasswordModal'); } catch (e) { /* ignore */ }
        }

        VIP.ui.showChatScreen();
        VIP.socket.startMessagePolling();
        VIP.refunds.loadRefundStatus();
        VIP.fire.loadFireStatus();
        VIP.ui.loadCanalInformativoUrl();

        return userLoaded;
    }

    function prepareChangePasswordModal() {
        const whatsappGroup = document.getElementById('changePasswordWhatsAppGroup');
        const whatsappInfo = document.getElementById('changePasswordWhatsAppInfo');
        const whatsappInput = document.getElementById('changePasswordWhatsApp');
        // Por requerimiento de Problema 2: el campo de teléfono se oculta SOLO si el usuario
        // ya tiene un teléfono verificado vía OTP. El campo `whatsapp` (no verificado) NO cuenta
        // como teléfono válido para saltarse la verificación, porque históricamente se guardó sin OTP.
        const verifiedPhone = VIP.state.currentUser
            && VIP.state.currentUser.phoneVerified === true
            && VIP.state.currentUser.phone
            ? VIP.state.currentUser.phone
            : null;

        if (whatsappGroup) {
            if (verifiedPhone) {
                whatsappGroup.style.display = 'none';
                if (whatsappInput) whatsappInput.removeAttribute('required');
            } else {
                whatsappGroup.style.display = '';
                if (whatsappInput) whatsappInput.setAttribute('required', '');
            }
        }
        if (whatsappInfo) {
            whatsappInfo.style.display = verifiedPhone ? 'block' : 'none';
            whatsappInfo.textContent = verifiedPhone ? `✅ Teléfono verificado: ${verifiedPhone}` : '';
        }

        // Reset del paso OTP: siempre arranca en paso 1 al abrir el modal.
        const otpStep = document.getElementById('changePasswordOtpStep');
        const form = document.getElementById('changePasswordForm');
        if (otpStep) otpStep.style.display = 'none';
        if (form) form.style.display = '';
        const otpCodeInput = document.getElementById('changePasswordOtpCode');
        if (otpCodeInput) otpCodeInput.value = '';
        const otpErr = document.getElementById('changePasswordOtpError');
        if (otpErr) { otpErr.textContent = ''; otpErr.classList.remove('show'); }
        _vipChangePwdPending = null;
        _stopChangePwdResendCooldown();

        // Actualizar título, subtítulo y botón de cierre según si el cambio es obligatorio
        const closeBtn = document.getElementById('changePasswordCloseBtn');
        const title = document.getElementById('changePasswordTitle');
        const subtitle = document.getElementById('changePasswordSubtitle');
        if (VIP.state.passwordChangePending) {
            if (closeBtn) closeBtn.style.display = 'none';
            if (title) title.textContent = '🔐 Cambio de Contraseña Obligatorio';
            if (subtitle) subtitle.innerHTML = 'Por seguridad, <strong>debés cambiar tu contraseña</strong> antes de continuar. No podés omitir este paso.';
        } else {
            if (closeBtn) closeBtn.style.display = '';
            if (title) title.textContent = '🔐 Cambiar Contraseña';
            if (subtitle) subtitle.textContent = 'Ingresá tu nueva contraseña para actualizarla.';
        }
    }

    // Estado pendiente del cambio de contraseña con OTP:
    // se guarda entre el paso 1 (datos) y el paso 2 (verificación OTP) para no perder
    // la nueva contraseña ni el teléfono mientras el usuario espera el SMS.
    let _vipChangePwdPending = null;
    let _vipChangePwdResendTimer = null;

    function _stopChangePwdResendCooldown() {
        if (_vipChangePwdResendTimer) {
            clearInterval(_vipChangePwdResendTimer);
            _vipChangePwdResendTimer = null;
        }
        const cooldownLabel = document.getElementById('changePasswordOtpResendCooldown');
        const resendBtn = document.getElementById('changePasswordOtpResendBtn');
        if (cooldownLabel) { cooldownLabel.style.display = 'none'; cooldownLabel.textContent = ''; }
        if (resendBtn) { resendBtn.style.display = ''; resendBtn.disabled = false; }
    }

    function _startChangePwdResendCooldown(seconds) {
        const cooldownLabel = document.getElementById('changePasswordOtpResendCooldown');
        const resendBtn = document.getElementById('changePasswordOtpResendBtn');
        let remaining = seconds;
        if (resendBtn) { resendBtn.style.display = 'none'; resendBtn.disabled = true; }
        if (cooldownLabel) {
            cooldownLabel.style.display = '';
            cooldownLabel.textContent = `Podés reenviar en ${remaining}s`;
        }
        if (_vipChangePwdResendTimer) clearInterval(_vipChangePwdResendTimer);
        _vipChangePwdResendTimer = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
                _stopChangePwdResendCooldown();
            } else if (cooldownLabel) {
                cooldownLabel.textContent = `Podés reenviar en ${remaining}s`;
            }
        }, 1000);
    }

    async function handleChangePassword(e) {
        if (e) e.preventDefault();

        const newPassword = document.getElementById('newPasswordInput').value;
        const confirmPassword = document.getElementById('confirmPasswordInput').value;
        const whatsappRaw = (document.getElementById('changePasswordWhatsApp')?.value || '').trim();
        const whatsappPrefix = (document.getElementById('changePasswordWhatsAppPrefix')?.value || '+54').trim();
        const errorDiv = document.getElementById('passwordError');

        // Solo consideramos teléfono válido si está VERIFICADO vía OTP.
        const verifiedPhone = VIP.state.currentUser
            && VIP.state.currentUser.phoneVerified === true
            && VIP.state.currentUser.phone
            ? VIP.state.currentUser.phone
            : null;
        // Construir número completo solo si se ingresó uno nuevo
        const whatsappFull = whatsappRaw ? (whatsappPrefix + whatsappRaw.replace(/^0+/, '')) : '';

        errorDiv.textContent = '';
        errorDiv.classList.remove('show');

        if (newPassword !== confirmPassword) {
            errorDiv.textContent = 'Las contraseñas no coinciden';
            errorDiv.classList.add('show');
            return;
        }
        if (newPassword.length < 6) {
            errorDiv.textContent = 'La contraseña debe tener al menos 6 caracteres';
            errorDiv.classList.add('show');
            return;
        }

        const closeAllSessions = document.getElementById('closeAllSessions').checked;

        // CASO A: el usuario ya tiene un teléfono verificado y NO está cambiándolo.
        // No se requiere OTP. Solo se cambia la contraseña.
        if (verifiedPhone && !whatsappFull) {
            return _commitPasswordChange({
                newPassword,
                closeAllSessions,
                phone: null,
                otpCode: null,
                errorDiv
            });
        }

        // CASO B: se está agregando o cambiando teléfono → OTP obligatorio.
        if (!whatsappFull) {
            errorDiv.textContent = 'El número de WhatsApp es obligatorio (más de 10 dígitos con prefijo internacional)';
            errorDiv.classList.add('show');
            return;
        }
        const digits = whatsappFull.replace(/\D/g, '');
        if (digits.length <= 10) {
            errorDiv.textContent = 'El número de WhatsApp es obligatorio (más de 10 dígitos con prefijo internacional)';
            errorDiv.classList.add('show');
            return;
        }
        // Si el usuario solo está cambiando contraseña pero también escribió su mismo teléfono ya verificado,
        // tratar como CASO A (sin OTP).
        if (verifiedPhone && whatsappFull === verifiedPhone) {
            return _commitPasswordChange({
                newPassword,
                closeAllSessions,
                phone: null,
                otpCode: null,
                errorDiv
            });
        }

        // Pedir OTP al backend y mostrar paso 2.
        const submitBtn = document.getElementById('changePasswordSubmitBtn');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '📱 Enviando código...'; }
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/change-password/send-otp`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify({ phone: whatsappFull })
            });
            const data = await response.json();
            if (!response.ok) {
                errorDiv.textContent = data.error || 'No se pudo enviar el código SMS';
                errorDiv.classList.add('show');
                return;
            }
            // Guardar contexto pendiente y mostrar paso 2.
            _vipChangePwdPending = {
                newPassword,
                phone: whatsappFull,
                closeAllSessions
            };
            const form = document.getElementById('changePasswordForm');
            const otpStep = document.getElementById('changePasswordOtpStep');
            const otpMsg = document.getElementById('changePasswordOtpMsg');
            if (form) form.style.display = 'none';
            if (otpStep) otpStep.style.display = '';
            const otpErr = document.getElementById('changePasswordOtpError');
            if (otpErr) { otpErr.textContent = ''; otpErr.classList.remove('show'); }
            const otpCodeInput = document.getElementById('changePasswordOtpCode');
            if (otpCodeInput) { otpCodeInput.value = ''; setTimeout(() => otpCodeInput.focus(), 50); }

            if (data.fallback) {
                console.warn('[OTP Fallback] SMS no enviado (change-password). Mostrando código alternativo en pantalla.', data.fallback.reason);
                if (otpMsg) _showOtpFallbackBanner('changePasswordOtpMsg', data.fallback, data.phone);
            } else {
                if (otpMsg) otpMsg.textContent = `Te enviamos un código SMS al ${data.phone || whatsappFull}. Ingresálo para confirmar el cambio.`;
            }
            _startChangePwdResendCooldown(60);
        } catch (err) {
            errorDiv.textContent = 'Error de conexión';
            errorDiv.classList.add('show');
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '💾 Guardar Cambios'; }
        }
    }

    async function _commitPasswordChange({ newPassword, closeAllSessions, phone, otpCode, errorDiv }) {
        try {
            const body = { newPassword, closeAllSessions };
            if (phone) {
                body.phone = phone;
                // Mantener `whatsapp` por compatibilidad con código existente.
                body.whatsapp = phone;
                body.otpCode = otpCode;
            }
            const response = await fetch(`${VIP.config.API_URL}/api/auth/change-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify(body)
            });
            const data = await response.json().catch(() => ({}));

            if (response.ok) {
                VIP.state.passwordChangePending = false;
                // Actualizar contraseña en memoria de sesión para el modal de plataforma
                VIP.state.sessionPassword = newPassword;
                // Reflejar el teléfono verificado en el estado local para no volver a pedirlo.
                if (data && data.phoneVerified && data.phone && VIP.state.currentUser) {
                    VIP.state.currentUser.phone = data.phone;
                    VIP.state.currentUser.phoneVerified = true;
                    VIP.state.currentUser.whatsapp = data.phone;
                }
                _vipChangePwdPending = null;
                _stopChangePwdResendCooldown();

                VIP.ui.hideModal('changePasswordModal');
                VIP.ui.showToast('✅ Contraseña guardada exitosamente', 'success');
                document.getElementById('newPasswordInput').value = '';
                document.getElementById('confirmPasswordInput').value = '';
                const wpInput = document.getElementById('changePasswordWhatsApp');
                if (wpInput) wpInput.value = '';
                const wpPrefix = document.getElementById('changePasswordWhatsAppPrefix');
                if (wpPrefix) wpPrefix.value = '+54';
                document.getElementById('closeAllSessions').checked = false;

                if (closeAllSessions) {
                    VIP.ui.showToast('🔒 Todas las sesiones han sido cerradas. Por favor, vuelve a iniciar sesión.', 'info');
                    setTimeout(() => {
                        localStorage.removeItem('userToken');
                        location.reload();
                    }, 2000);
                }
                return true;
            }

            const target = errorDiv || document.getElementById('changePasswordOtpError') || document.getElementById('passwordError');
            if (target) {
                target.textContent = (data && data.error) || 'Error al cambiar contraseña';
                target.classList.add('show');
            }
            return false;
        } catch (error) {
            const target = errorDiv || document.getElementById('changePasswordOtpError') || document.getElementById('passwordError');
            if (target) {
                target.textContent = 'Error de conexión';
                target.classList.add('show');
            }
            return false;
        }
    }

    async function handleChangePasswordOtpVerify() {
        const otpErr = document.getElementById('changePasswordOtpError');
        const verifyBtn = document.getElementById('changePasswordOtpVerifyBtn');
        if (otpErr) { otpErr.textContent = ''; otpErr.classList.remove('show'); }

        if (!_vipChangePwdPending) {
            if (otpErr) {
                otpErr.textContent = 'Sesión de verificación expirada. Volvé a iniciar el cambio.';
                otpErr.classList.add('show');
            }
            return;
        }
        const code = (document.getElementById('changePasswordOtpCode')?.value || '').trim();
        if (!code || code.length < 6) {
            if (otpErr) {
                otpErr.textContent = 'Ingresá el código de 6 dígitos';
                otpErr.classList.add('show');
            }
            return;
        }
        if (verifyBtn) { verifyBtn.disabled = true; verifyBtn.textContent = 'Verificando...'; }
        const ok = await _commitPasswordChange({
            newPassword: _vipChangePwdPending.newPassword,
            closeAllSessions: _vipChangePwdPending.closeAllSessions,
            phone: _vipChangePwdPending.phone,
            otpCode: code,
            errorDiv: otpErr
        });
        if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.textContent = '✅ Verificar y Guardar'; }
        // Si falló (p. ej. OTP incorrecto), el backend ya gestiona los 3 intentos vía OtpCode.
        // El usuario puede reintentar o pedir un nuevo código con el botón de reenvío.
        if (!ok) {
            const codeInput = document.getElementById('changePasswordOtpCode');
            if (codeInput) { codeInput.value = ''; codeInput.focus(); }
        }
    }

    async function handleChangePasswordOtpResend() {
        const otpErr = document.getElementById('changePasswordOtpError');
        if (!_vipChangePwdPending) {
            if (otpErr) {
                otpErr.textContent = 'Sesión de verificación expirada. Volvé a iniciar el cambio.';
                otpErr.classList.add('show');
            }
            return;
        }
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/change-password/send-otp`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify({ phone: _vipChangePwdPending.phone })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                if (otpErr) {
                    otpErr.textContent = (data && data.error) || 'No se pudo reenviar el código';
                    otpErr.classList.add('show');
                }
                return;
            }
            const otpMsg = document.getElementById('changePasswordOtpMsg');
            if (data && data.fallback) {
                console.warn('[OTP Fallback] SMS no enviado en reenvío (change-password). Mostrando código alternativo.', data.fallback.reason);
                if (otpMsg) _showOtpFallbackBanner('changePasswordOtpMsg', data.fallback, data.phone);
            } else {
                if (otpMsg) otpMsg.textContent = `Te reenviamos el código SMS al ${(data && data.phone) || _vipChangePwdPending.phone}.`;
            }
            _startChangePwdResendCooldown(60);
        } catch (err) {
            if (otpErr) {
                otpErr.textContent = 'Error de conexión';
                otpErr.classList.add('show');
            }
        }
    }

    function handleChangePasswordOtpBack() {
        _vipChangePwdPending = null;
        _stopChangePwdResendCooldown();
        const otpStep = document.getElementById('changePasswordOtpStep');
        const form = document.getElementById('changePasswordForm');
        if (otpStep) otpStep.style.display = 'none';
        if (form) form.style.display = '';
        const otpErr = document.getElementById('changePasswordOtpError');
        if (otpErr) { otpErr.textContent = ''; otpErr.classList.remove('show'); }
    }

    // Estado temporal del reset OTP
    let _vipResetOtpPhone = null;
    let _vipResetToken = null;

    async function handleFindUserByPhone(e) {
        // ELIMINADO: Este endpoint permitía enumerar usuarios.
        // El reset de contraseña ahora usa flujo OTP seguro (anti-enumeration).
        if (e) e.preventDefault();
    }

    async function handleRequestPasswordReset() {
        const phonePrefix = document.getElementById('resetPhonePrefix').value;
        const phoneNumber = document.getElementById('resetPassPhone').value.trim();
        const resultDiv = document.getElementById('resetStep1Result');

        if (resultDiv) resultDiv.style.display = 'none';

        if (!phoneNumber || phoneNumber.replace(/\D/g, '').length < 8) {
            if (resultDiv) {
                resultDiv.textContent = 'Ingresá un número de teléfono válido (mínimo 8 dígitos)';
                resultDiv.style.background = 'rgba(255, 68, 68, 0.2)';
                resultDiv.style.color = '#ff4444';
                resultDiv.style.display = 'block';
            }
            return;
        }

        const fullPhone = phonePrefix + phoneNumber.replace(/[\s\-().]/g, '');
        _vipResetOtpPhone = fullPhone;

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/request-password-reset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: fullPhone })
            });
            const data = await response.json();

            document.getElementById('resetStep1').style.display = 'none';
            document.getElementById('resetStep2').style.display = '';
            document.getElementById('resetStep2Msg').textContent = data.message || 'Si este número está vinculado a una cuenta, recibirás un código SMS.';
            document.getElementById('resetOtpCode').value = '';
            const errDiv = document.getElementById('resetStep2Error');
            if (errDiv) errDiv.style.display = 'none';
        } catch (error) {
            if (resultDiv) {
                resultDiv.textContent = 'Error de conexión. Intenta más tarde.';
                resultDiv.style.background = 'rgba(255, 68, 68, 0.2)';
                resultDiv.style.color = '#ff4444';
                resultDiv.style.display = 'block';
            }
        }
    }

    async function handleVerifyResetOtp() {
        const code = document.getElementById('resetOtpCode').value.trim();
        const errDiv = document.getElementById('resetStep2Error');

        if (errDiv) errDiv.style.display = 'none';

        if (!code || code.length < 6) {
            if (errDiv) { errDiv.textContent = 'Ingresá el código de 6 dígitos'; errDiv.style.display = 'block'; }
            return;
        }

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/verify-reset-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: _vipResetOtpPhone, code })
            });
            const data = await response.json();

            if (response.ok && data.success) {
                _vipResetToken = data.resetToken;
                document.getElementById('resetStep2').style.display = 'none';
                document.getElementById('resetStep3').style.display = '';
                document.getElementById('resetStep3Username').textContent = `👤 Usuario: ${escapeHtml(data.username)}`;
                document.getElementById('resetPassNew').value = '';
                document.getElementById('resetPassConfirm').value = '';
                const errDiv3 = document.getElementById('resetStep3Error');
                if (errDiv3) errDiv3.style.display = 'none';
            } else {
                if (errDiv) { errDiv.textContent = data.error || 'Código incorrecto o expirado'; errDiv.style.display = 'block'; }
            }
        } catch (error) {
            if (errDiv) { errDiv.textContent = 'Error de conexión. Intenta más tarde.'; errDiv.style.display = 'block'; }
        }
    }

    async function handleResetPasswordByPhone(e) {
        // MANTENIDO por compatibilidad con HTML (resetPassForm) - redirige al nuevo flujo OTP
        if (e) e.preventDefault();
        // El nuevo flujo usa handleRequestPasswordReset, handleVerifyResetOtp, handleCompletePasswordReset
    }

    async function handleCompletePasswordReset() {
        const newPassword = document.getElementById('resetPassNew').value;
        const confirmPassword = document.getElementById('resetPassConfirm').value;
        const resultDiv = document.getElementById('resetPassResult');
        const errDiv = document.getElementById('resetStep3Error');

        if (errDiv) errDiv.style.display = 'none';
        if (resultDiv) resultDiv.style.display = 'none';

        if (newPassword.length < 6) {
            if (errDiv) { errDiv.textContent = 'La contraseña debe tener al menos 6 caracteres'; errDiv.style.display = 'block'; }
            return;
        }
        if (newPassword !== confirmPassword) {
            if (errDiv) { errDiv.textContent = 'Las contraseñas no coinciden'; errDiv.style.display = 'block'; }
            return;
        }

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/complete-password-reset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ resetToken: _vipResetToken, newPassword })
            });
            const data = await response.json();

            if (data.success) {
                _vipResetToken = null;
                _vipResetOtpPhone = null;
                if (resultDiv) {
                    resultDiv.innerHTML = `<p style="color: #00ff88; font-size: 16px; font-weight: bold; text-align:center;">✅ Contraseña cambiada exitosamente</p><p style="color: #888; font-size: 12px; text-align:center;">Ya puedes iniciar sesión con tu nueva contraseña</p>`;
                    resultDiv.style.background = 'rgba(0, 255, 136, 0.2)';
                    resultDiv.style.display = 'block';
                }
                document.getElementById('resetStep3').style.display = 'none';
            } else {
                if (errDiv) { errDiv.textContent = data.error || 'Error al cambiar contraseña'; errDiv.style.display = 'block'; }
            }
        } catch (error) {
            if (errDiv) { errDiv.textContent = 'Error de conexión. Intenta más tarde.'; errDiv.style.display = 'block'; }
        }
    }

    function switchLoginMode(mode) {
        window._loginMode = mode;
        const usernameGroup = document.getElementById('loginUsernameGroup');
        const phoneGroup = document.getElementById('loginPhoneGroup');
        const usernameBtn = document.getElementById('loginByUsernameBtn');
        const phoneBtn = document.getElementById('loginByPhoneBtn');
        const usernameInput = document.getElementById('username');
        const phoneLoginModeToggle = document.getElementById('phoneLoginModeToggle');
        const phoneOtpStep = document.getElementById('phoneOtpStep');
        // iOS Safari < 15.4 no soporta `:has()` y tira SyntaxError en querySelector — eso abortaba
        // el handler y dejaba el toggle "Celular" sin responder al tap. Resolvemos el grupo
        // navegando desde el input por id hasta su `.input-group` ancestro (compatible siempre).
        const passwordInputEl = document.getElementById('password');
        const passwordGroup = passwordInputEl ? passwordInputEl.closest('.input-group') : null;
        const submitBtn = document.querySelector('#loginForm button[type="submit"]');

        if (mode === 'phone') {
            if (usernameGroup) usernameGroup.classList.add('hidden');
            if (phoneGroup) phoneGroup.classList.remove('hidden');
            if (usernameInput) usernameInput.removeAttribute('required');
            if (usernameBtn) { usernameBtn.style.background = 'transparent'; usernameBtn.style.color = '#888'; usernameBtn.style.fontWeight = 'normal'; }
            if (phoneBtn) { phoneBtn.style.background = 'rgba(212,175,55,0.2)'; phoneBtn.style.color = '#d4af37'; phoneBtn.style.fontWeight = '600'; }
            if (phoneLoginModeToggle) phoneLoginModeToggle.classList.remove('hidden');
        } else {
            if (usernameGroup) usernameGroup.classList.remove('hidden');
            if (phoneGroup) phoneGroup.classList.add('hidden');
            if (usernameInput) usernameInput.setAttribute('required', '');
            if (usernameBtn) { usernameBtn.style.background = 'rgba(212,175,55,0.2)'; usernameBtn.style.color = '#d4af37'; usernameBtn.style.fontWeight = '600'; }
            if (phoneBtn) { phoneBtn.style.background = 'transparent'; phoneBtn.style.color = '#888'; phoneBtn.style.fontWeight = 'normal'; }
            if (phoneLoginModeToggle) phoneLoginModeToggle.classList.add('hidden');
            if (phoneOtpStep) phoneOtpStep.classList.add('hidden');
            // Reset phone login mode to password
            window._phoneLoginMode = 'password';
            if (passwordGroup) passwordGroup.style.display = '';
            if (submitBtn) submitBtn.textContent = 'Ingresar a la Sala';
            if (submitBtn) submitBtn.style.display = '';
        }
    }

    return {
        checkUsernameAvailability,
        handleRegister,
        handleRegisterSendOtp,
        handleRegisterWithOtp,
        handleLogin,
        verifyToken,
        handleLogout,
        ensureUserLoaded,
        initializeSession,
        handleChangePassword,
        handleChangePasswordOtpVerify,
        handleChangePasswordOtpResend,
        handleChangePasswordOtpBack,
        handleFindUserByPhone,
        handleResetPasswordByPhone,
        handleRequestPasswordReset,
        handleVerifyResetOtp,
        handleCompletePasswordReset,
        prepareChangePasswordModal,
        switchLoginMode
    };

})();

// Window aliases for any HTML onclick / external callers
window.checkUsernameAvailability = VIP.auth.checkUsernameAvailability;
window.handleRegisterSendOtp = VIP.auth.handleRegisterSendOtp;
window.handleRegisterWithOtp = VIP.auth.handleRegisterWithOtp;
window.handleRequestPasswordReset = VIP.auth.handleRequestPasswordReset;
window.handleVerifyResetOtp = VIP.auth.handleVerifyResetOtp;
window.handleCompletePasswordReset = VIP.auth.handleCompletePasswordReset;
window.switchLoginMode = VIP.auth.switchLoginMode;

// Phone login OTP mode functions (global scope for onclick handlers)
window._phoneLoginMode = 'password';
window._phoneOtpFullPhone = null;

window.switchPhoneLoginMode = function(mode) {
    window._phoneLoginMode = mode;
    // iOS Safari < 15.4 no soporta `:has()` — usar closest desde el input por id (ver fix en switchLoginMode).
    var passwordInputEl = document.getElementById('password');
    var passwordGroup = passwordInputEl ? passwordInputEl.closest('.input-group') : null;
    var submitBtn = document.querySelector('#loginForm button[type="submit"]');
    var otpStep = document.getElementById('phoneOtpStep');
    var passwordBtn = document.getElementById('phoneLoginByPassword');
    var otpBtn = document.getElementById('phoneLoginByOtp');

    if (mode === 'otp') {
        if (passwordGroup) passwordGroup.style.display = 'none';
        if (submitBtn) submitBtn.textContent = '📱 Enviar código SMS';
        if (otpStep) otpStep.classList.add('hidden');
        if (passwordBtn) { passwordBtn.style.background = 'transparent'; passwordBtn.style.color = '#888'; passwordBtn.style.fontWeight = 'normal'; }
        if (otpBtn) { otpBtn.style.background = 'rgba(212,175,55,0.2)'; otpBtn.style.color = '#d4af37'; otpBtn.style.fontWeight = '600'; }
    } else {
        if (passwordGroup) passwordGroup.style.display = '';
        if (submitBtn) submitBtn.textContent = 'Ingresar a la Sala';
        if (otpStep) otpStep.classList.add('hidden');
        if (passwordBtn) { passwordBtn.style.background = 'rgba(212,175,55,0.2)'; passwordBtn.style.color = '#d4af37'; passwordBtn.style.fontWeight = '600'; }
        if (otpBtn) { otpBtn.style.background = 'transparent'; otpBtn.style.color = '#888'; otpBtn.style.fontWeight = 'normal'; }
    }
};

window.handlePhoneOtpVerify = async function() {
    var code = document.getElementById('phoneOtpCode').value.trim();
    var errorDiv = document.getElementById('errorMessage');
    var verifyBtn = document.getElementById('phoneOtpVerifyBtn');

    if (!code || code.length < 6) {
        errorDiv.textContent = 'Ingresá el código de 6 dígitos';
        errorDiv.classList.add('show');
        return;
    }

    if (verifyBtn) { verifyBtn.textContent = 'Verificando...'; verifyBtn.disabled = true; }

    try {
        var response = await fetch((VIP.config.API_URL || '') + '/api/auth/login-otp-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: window._phoneOtpFullPhone, code: code })
        });
        var data = await response.json();

        if (response.ok && data.token) {
            VIP.state.currentToken = data.token;
            VIP.state.currentUser = { ...data.user, id: data.user.id, userId: data.user.id };
            localStorage.setItem('userToken', VIP.state.currentToken);
            await VIP.auth.initializeSession(false);
            VIP.notifications.sendFcmTokenAfterLogin();
        } else {
            errorDiv.textContent = data.error || 'Código incorrecto o expirado';
            errorDiv.classList.add('show');
        }
    } catch (error) {
        errorDiv.textContent = 'Error de conexión';
        errorDiv.classList.add('show');
    } finally {
        if (verifyBtn) { verifyBtn.textContent = '✅ Verificar código'; verifyBtn.disabled = false; }
    }
};

// ============================================================
// Global fetch interceptor: detect server-side enforcement of
// mandatory password change (HTTP 403 with `code: MUST_CHANGE_PASSWORD`).
//
// This covers the "reload bypass" attack: even if the user reloads the page
// or tries to call any authenticated API directly, the server returns 403
// for non-allow-listed endpoints while `user.mustChangePassword === true`.
// We catch that response globally, flip the in-memory flag, and re-open
// the mandatory change modal.
// ============================================================
(function installMustChangePasswordInterceptor() {
    if (typeof window === 'undefined' || !window.fetch || window.__vipMustChangePasswordInterceptorInstalled) {
        return;
    }
    window.__vipMustChangePasswordInterceptorInstalled = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = async function (...args) {
        const response = await originalFetch(...args);
        try {
            if (response && response.status === 403) {
                // Clone so the original consumer can still read the body.
                const clone = response.clone();
                const contentType = clone.headers.get('content-type') || '';
                if (contentType.indexOf('application/json') !== -1) {
                    const body = await clone.json().catch(() => null);
                    if (body && body.code === 'MUST_CHANGE_PASSWORD') {
                        // Only re-prepare the modal the first time we see the
                        // server-side enforcement. Otherwise repeated background
                        // requests (balance polling, fire status, etc.) would
                        // keep resetting the OTP step while the user types it.
                        if (!VIP.state.passwordChangePending) {
                            VIP.state.passwordChangePending = true;
                            try {
                                if (VIP.auth && typeof VIP.auth.prepareChangePasswordModal === 'function') {
                                    VIP.auth.prepareChangePasswordModal();
                                }
                            } catch (e) { /* ignore */ }
                            try {
                                if (VIP.ui && typeof VIP.ui.showModal === 'function') {
                                    VIP.ui.showModal('changePasswordModal');
                                }
                            } catch (e) { /* ignore */ }
                        }
                    }
                }
            }
        } catch (e) {
            // Never let the interceptor break the original request flow.
        }
        return response;
    };
})();
