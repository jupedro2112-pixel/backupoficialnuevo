
// ========================================
// CONFIGURACIÓN
// ========================================

const API_URL = '';
let currentToken = localStorage.getItem('userToken');
let currentUser = null;
let refundStatus = null;
let refundTimers = {};
let lastMessageId = null;
let messageCheckInterval = null;
let balanceCheckInterval = null;
let processedMessageIds = new Set(); // Para evitar mensajes duplicados
let pendingSentMessages = new Map(); // Tracking de mensajes enviados pendientes
let lastSentMessageTimestamp = 0; // Timestamp del último mensaje enviado
let passwordChangePending = false; // Flag: cambio de contraseña obligatorio pendiente

// Rate limiting frontend para mensajes (segunda línea de defensa; el backend es la primaria)
const sentMessageTimestamps = []; // sliding window de timestamps
const FRONTEND_MSG_RATE_MAX = 2;
const FRONTEND_MSG_RATE_WINDOW_MS = 1000;

// Protección anti-spam para botón CBU
let lastCbuClickTime = 0;
const CBU_CLICK_COOLDOWN_MS = 10000; // 10 segundos

// Función para obtener fecha en hora Argentina
function getArgentinaDate(date = new Date()) {
    return new Date(date.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
}

// Función para obtener timestamp de medianoche en Argentina
function getArgentinaMidnight() {
    const argentinaNow = getArgentinaDate();
    const midnight = new Date(argentinaNow);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime();
}

// ========================================
// INICIALIZACIÓN
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    if (currentToken) {
        verifyToken();
    }
    setupEventListeners();
    
    // Auto-rellenar código de referido desde URL ?ref=CODE
    const urlParams = new URLSearchParams(window.location.search);
    const refCode = urlParams.get('ref');
    if (refCode) {
        const refInput = document.getElementById('registerReferralCode');
        if (refInput) refInput.value = refCode.toUpperCase();
        // Mostrar un banner invitando a registrarse con el código
        const registerBtn = document.getElementById('registerBtn');
        if (registerBtn) {
            registerBtn.style.background = 'linear-gradient(135deg, #d4af37 0%, #b8860b 100%)';
            registerBtn.textContent = '🤝 Registrarse con código de referido';
        }
    }

    // CORREGIDO: Registrar Service Worker para notificaciones push
    registerUserServiceWorker();

    // Ajustar layout dinámicamente según altura real del header
    adjustLayout();
});

window.addEventListener('load', adjustLayout);
window.addEventListener('resize', adjustLayout);
// Pequeño delay para que el navegador complete el reflow tras cambio de orientación
window.addEventListener('orientationchange', () => setTimeout(adjustLayout, 150));

// Service Worker registration is handled by the inline script in index.html
// (registers /user-sw.js with updateViaCache:'none' and passes the registration
// to FCM so push subscriptions are stable across page loads).
// This function is kept as a no-op to avoid breaking any existing call sites.
async function registerUserServiceWorker() {
    // No-op: registration is done in index.html inline script
}

// CORREGIDO: Solicitar permiso para notificaciones
async function requestNotificationPermission() {
    if (!('Notification' in window)) {
        console.log('⚠️ Notificaciones no soportadas');
        return;
    }
    
    const permission = await Notification.requestPermission();
    console.log('🔔 Permiso de notificaciones:', permission);
    
    if (permission === 'granted') {
        console.log('✅ Notificaciones permitidas');
    }
}

function setupEventListeners() {
    // Login
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);
    document.getElementById('helpBtn').addEventListener('click', () => {
        window.open('https://wa.link/metawin2026', '_blank');
    });
    document.getElementById('installBtn').addEventListener('click', installApp);

    // ¿Olvidaste tu contraseña?
    const forgotPasswordBtn = document.getElementById('forgotPasswordBtn');
    if (forgotPasswordBtn) {
        forgotPasswordBtn.addEventListener('click', () => showModal('resetPassModal'));
    }
    
    // Botón de instalar en el header (si existe)
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    if (headerInstallBtn) {
        headerInstallBtn.addEventListener('click', installApp);
    }
    
    // CORREGIDO: Botón APP en el header al lado de soporte
    const appInstallBtn = document.getElementById('appInstallBtn');
    if (appInstallBtn) {
        appInstallBtn.addEventListener('click', installApp);
    }
    
    // Registro
    document.getElementById('registerBtn').addEventListener('click', () => showModal('registerModal'));
    document.getElementById('closeRegisterModal').addEventListener('click', () => hideModal('registerModal'));
    document.getElementById('registerForm').addEventListener('submit', handleRegister);
    
    // Chat
    document.getElementById('sendBtn').addEventListener('click', sendMessage);
    
    const messageInput = document.getElementById('messageInput');
    // CORREGIDO: Usar keydown en lugar de keypress para mejor compatibilidad
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
        // Shift+Enter permite el salto de línea normal (comportamiento por defecto)
    });
    
    // Indicador "Escribiendo..."
    let typingTimeout;
    messageInput.addEventListener('input', function() {
        if (socket) {
            socket.emit('typing', { isTyping: true });
            clearTimeout(typingTimeout);
            typingTimeout = setTimeout(() => {
                socket.emit('stop_typing', {});
            }, 2000);
        }
    });
    
    // Adjuntar imagen
    document.getElementById('attachBtn').addEventListener('click', () => {
        document.getElementById('fileInput').click();
    });
    document.getElementById('fileInput').addEventListener('change', handleFileSelect);

    // Pegar imagen con Ctrl+V desde portapapeles (escritorio)
    document.getElementById('messageInput').addEventListener('paste', handlePaste);
    
    // Reembolsos
    document.getElementById('dailyRefundBtn').addEventListener('click', () => showRefundModal('daily'));
    document.getElementById('weeklyRefundBtn').addEventListener('click', () => showRefundModal('weekly'));
    document.getElementById('monthlyRefundBtn').addEventListener('click', () => showRefundModal('monthly'));
    document.getElementById('closeRefundModal').addEventListener('click', () => hideModal('refundModal'));
    
    // Fueguito
    const fireBtn = document.getElementById('fireBtn');
    if (fireBtn) {
        fireBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('🔥 Fueguito clickeado');
            showFireModal();
        });
    }
    document.getElementById('closeFireModal').addEventListener('click', () => hideModal('fireModal'));
    document.getElementById('claimFireBtn').addEventListener('click', claimFire);
    
    // Referidos
    document.getElementById('referralBtn').addEventListener('click', () => openReferralModal());
    
    // Información del servicio
    document.getElementById('infoBtn').addEventListener('click', () => showModal('infoModal'));
    document.getElementById('closeInfoModal').addEventListener('click', () => hideModal('infoModal'));
    
    // CBU - botón en header
    // Botón cbuUserBtn eliminado - ya no se usa
    // document.getElementById('cbuUserBtn').addEventListener('click', loadAndShowCBU);
    
    // CBU - botón en chat input
    document.getElementById('cbuChatBtn').addEventListener('click', loadAndShowCBU);
    
    // Configuración
    document.getElementById('settingsBtn').addEventListener('click', () => showModal('settingsModal'));
    document.getElementById('closeSettingsModal').addEventListener('click', () => hideModal('settingsModal'));
    document.getElementById('changePasswordSettingsBtn').addEventListener('click', () => {
        hideModal('settingsModal');
        // Mostrar u ocultar el campo WhatsApp según si ya tiene número vinculado
        prepareChangePasswordModal();
        showModal('changePasswordModal');
    });
    
    // Buscar usuario por teléfono
    document.getElementById('findUserBtn').addEventListener('click', () => showModal('findUserModal'));
    document.getElementById('findUserForm').addEventListener('submit', handleFindUserByPhone);
    
    // Cambiar contraseña por teléfono
    // Botón resetPassBtn eliminado - ya no se usa
    // document.getElementById('resetPassBtn').addEventListener('click', () => showModal('resetPassModal'));
    document.getElementById('resetPassForm').addEventListener('submit', handleResetPasswordByPhone);
    
    // Cambio de contraseña
    document.getElementById('changePasswordForm').addEventListener('submit', handleChangePassword);
    
    // Auto-resize textarea
    const textarea = document.getElementById('messageInput');
    textarea.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    });
}

// ========================================
// AUTENTICACIÓN
// ========================================

// Verificar disponibilidad de username
async function checkUsernameAvailability(username) {
    const resultSpan = document.getElementById('usernameCheckResult');
    
    try {
        const response = await fetch(`${API_URL}/api/auth/check-username?username=${encodeURIComponent(username)}`);
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

// Manejar registro
async function handleRegister(e) {
    e.preventDefault();
    
    const username = document.getElementById('registerUsername').value.trim();
    const password = document.getElementById('registerPassword').value;
    const passwordConfirm = document.getElementById('registerPasswordConfirm').value;
    const email = document.getElementById('registerEmail').value.trim();
    const phone = document.getElementById('registerPhone').value.trim();
    const referralCodeInput = document.getElementById('registerReferralCode');
    const referralCode = referralCodeInput ? referralCodeInput.value.trim().toUpperCase() : null;
    const errorDiv = document.getElementById('registerError');
    const submitBtn = e.target.querySelector('button[type="submit"]');
    
    // Validaciones
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
    
    // Mostrar estado de carga
    if (submitBtn) {
        submitBtn.textContent = 'Creando cuenta...';
        submitBtn.disabled = true;
    }
    errorDiv.classList.remove('show');
    
    try {
        const response = await fetch(`${API_URL}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                username, 
                password, 
                email: email || null, 
                phone: phone || null,
                referralCode: referralCode || undefined
            })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            // Registro exitoso, iniciar sesión automáticamente
            currentToken = data.token;
            currentUser = {
                ...data.user,
                id: data.user.id,
                userId: data.user.id
            };
            localStorage.setItem('userToken', currentToken);
            
            hideModal('registerModal');
            document.getElementById('registerForm').reset();
            document.getElementById('usernameCheckResult').textContent = '';
            
            // Inicializar sesión con carga automática de usuario (true = después de registro)
            await initializeSession(true);
            
            // Enviar token FCM al servidor después del registro
            console.log('[FCM] Registro exitoso, enviando token FCM...');
            await sendFcmTokenAfterLogin();
            
            showToast('✅ ¡Cuenta creada exitosamente!', 'success');
        } else {
            errorDiv.textContent = data.error || 'Error al crear cuenta';
            errorDiv.classList.add('show');
        }
    } catch (error) {
        errorDiv.textContent = 'Error de conexión';
        errorDiv.classList.add('show');
    } finally {
        // Restaurar botón
        if (submitBtn) {
            submitBtn.textContent = '📝 Crear Cuenta';
            submitBtn.disabled = false;
        }
    }
}

async function handleLogin(e) {
    e.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('errorMessage');
    const loginBtn = document.querySelector('#loginForm button[type="submit"]');
    
    // Mostrar estado de carga
    if (loginBtn) {
        loginBtn.textContent = 'Ingresando...';
        loginBtn.disabled = true;
    }
    errorDiv.classList.remove('show');
    
    // Timeout para evitar quedar colgado
    const loginTimeout = setTimeout(() => {
        errorDiv.textContent = 'Tiempo de espera agotado. Intenta nuevamente.';
        errorDiv.classList.add('show');
        if (loginBtn) {
            loginBtn.textContent = 'Ingresar a la Sala';
            loginBtn.disabled = false;
        }
    }, 15000); // 15 segundos timeout
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 segundos para la petición
        
        const response = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        clearTimeout(loginTimeout);
        
        const data = await response.json();
        
        if (response.ok) {
            currentToken = data.token;
            // Asegurar que tenemos id y userId
            currentUser = {
                ...data.user,
                id: data.user.id,
                userId: data.user.id
            };
            localStorage.setItem('userToken', currentToken);
            
            // Inicializar sesión con carga automática de usuario
            try {
                await initializeSession(false);
            } catch (initError) {
                console.error('Error inicializando sesión:', initError);
                // Continuar de todos modos, el usuario ya está logueado
            }
            
            if (data.user.needsPasswordChange) {
                passwordChangePending = true;
                prepareChangePasswordModal();
                showModal('changePasswordModal');
            }
            
            // CORREGIDO: Solicitar permiso para notificaciones del navegador
            requestNotificationPermission();
            
            // ENVIAR TOKEN FCM AL SERVIDOR DESPUÉS DEL LOGIN
            sendFcmTokenAfterLogin();
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
        // SIEMPLE restaurar botón al final
        if (loginBtn) {
            loginBtn.textContent = 'Ingresar a la Sala';
            loginBtn.disabled = false;
        }
    }
}

// ============================================
// ENVIAR TOKEN FCM AL SERVIDOR DESPUÉS DEL LOGIN
// ============================================
async function sendFcmTokenAfterLogin() {
    const fcmToken = localStorage.getItem('fcmToken');
    const authToken = localStorage.getItem('userToken'); // El login guarda como 'userToken'
    
    console.log('[FCM] sendFcmTokenAfterLogin() - fcmToken:', fcmToken ? 'Sí (30 chars: ' + fcmToken.substring(0, 30) + '...)' : 'No');
    console.log('[FCM] sendFcmTokenAfterLogin() - authToken:', authToken ? 'Sí' : 'No');
    
    if (fcmToken && authToken) {
        console.log('[FCM] Enviando token al servidor después del login...');
        console.log('[FCM] Token FCM:', fcmToken.substring(0, 30) + '...');
        try {
            const response = await fetch(`${API_URL}/api/notifications/register-token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + authToken
                },
                body: JSON.stringify({ fcmToken: fcmToken })
            });
            
            const data = await response.json();
            if (data.success) {
                console.log('[FCM] ✅ Token registrado en el servidor');
                showToast('✅ Notificaciones activadas correctamente', 'success');
            } else {
                console.log('[FCM] ⚠️ No se pudo registrar el token:', data.error);
            }
        } catch (error) {
            console.log('[FCM] ⚠️ Error al registrar token:', error.message);
        }
    } else {
        console.log('[FCM] No hay token FCM o authToken disponible');
        console.log('[FCM] fcmToken:', fcmToken ? 'Sí' : 'No');
        console.log('[FCM] authToken:', authToken ? 'Sí' : 'No');
    }
}

async function verifyToken() {
    try {
        const response = await fetch(`${API_URL}/api/auth/verify`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            
            // Si falta información crítica del usuario, recargar desde el servidor
            if (!data.user || !data.user.username) {
                console.log('Token válido pero falta información de usuario, recargando...');
                // Intentar obtener información completa del usuario
                const userResponse = await fetch(`${API_URL}/api/users/me`, {
                    headers: { 'Authorization': `Bearer ${currentToken}` }
                });
                
                if (userResponse.ok) {
                    const userData = await userResponse.json();
                    currentUser = {
                        ...userData,
                        id: userData.id || userData.userId,
                        userId: userData.userId || userData.id
                    };
                } else {
                    // Si no se puede obtener el usuario, usar lo que tenemos
                    currentUser = {
                        ...data.user,
                        id: data.user.id || data.user.userId,
                        userId: data.user.userId || data.user.id
                    };
                }
            } else {
                // Normalizar: el verify devuelve userId, el login devuelve id
                currentUser = {
                    ...data.user,
                    id: data.user.id || data.user.userId,
                    userId: data.user.userId || data.user.id
                };
            }
            
            showChatScreen();
            startMessagePolling();
            loadRefundStatus();
            loadFireStatus();
            
            // CORREGIDO: Solicitar permiso para notificaciones del navegador
            requestNotificationPermission();

            // Re-sincronizar token FCM con el servidor en cada reanudación de sesión.
            // Si el token fue borrado del backend (por un envío fallido previo), esto
            // lo vuelve a registrar automáticamente sin esperar un login nuevo.
            // sendFcmTokenAfterLogin está siempre definida: se declara en app.js y el
            // script inline de index.html la sobreescribe con la versión mejorada.
            sendFcmTokenAfterLogin().catch(function(e) {
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
    stopMessagePolling();
    stopBalancePolling();
    currentToken = null;
    currentUser = null;
    localStorage.removeItem('userToken');
    // Limpiar estado FCM para evitar que el siguiente usuario herede el token de esta sesión
    localStorage.removeItem('fcmToken');
    localStorage.removeItem('fcmTokenContext');
    localStorage.removeItem('fcmTokenUserId');
    showLoginScreen();
}

// ========================================
// CARGA AUTOMÁTICA DE USUARIO
// ========================================

// Asegurar que el usuario esté completamente cargado
// Esta función se llama después de login/register para evitar "usuario no encontrado"
async function ensureUserLoaded(retries = 3) {
    // Si ya tenemos todos los datos necesarios, no hacer nada
    if (currentUser && currentUser.id && currentUser.username) {
        console.log('✅ Usuario ya cargado completamente:', currentUser.username);
        return true;
    }
    
    console.log('🔄 Cargando usuario automáticamente...');
    
    for (let i = 0; i < retries; i++) {
        try {
            // Intentar obtener los datos del usuario desde el servidor
            const response = await fetch(`${API_URL}/api/users/me`, {
                headers: { 'Authorization': `Bearer ${currentToken}` }
            });
            
            if (response.ok) {
                const userData = await response.json();
                
                if (userData && userData.username) {
                    currentUser = {
                        ...userData,
                        id: userData.id || userData._id,
                        userId: userData.id || userData._id
                    };
                    console.log('✅ Usuario cargado exitosamente:', currentUser.username);
                    return true;
                }
            } else if (response.status === 404) {
                // Usuario no encontrado - esperar un momento y reintentar
                // (puede pasar con usuarios recién creados)
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

// Función para inicializar la sesión después de login/register
async function initializeSession(afterRegister = false) {
    console.log('🚀 Inicializando sesión...');
    
    // Asegurar que el usuario esté cargado
    const userLoaded = await ensureUserLoaded(afterRegister ? 5 : 3);
    
    if (!userLoaded) {
        // Si no se pudo cargar el usuario, mostrar error pero continuar de todos modos
        // (el usuario puede recargar la página si es necesario)
        console.warn('⚠️ No se pudo cargar el usuario completamente, pero continuando...');
    }
    
    // Mostrar la pantalla de chat y cargar datos
    showChatScreen();
    startMessagePolling();
    loadRefundStatus();
    loadFireStatus();
    loadCanalInformativoUrl();
    
    return userLoaded;
}

// ========================================
// CBU - DATOS PARA TRANSFERIR
// ========================================

async function loadAndShowCBU() {
    // Protección anti-spam: máximo 1 clic cada 10 segundos
    const now = Date.now();
    if (now - lastCbuClickTime < CBU_CLICK_COOLDOWN_MS) {
        showToast('Espera unos segundos antes de volver a solicitar el CBU.', 'info');
        return;
    }
    lastCbuClickTime = now;

    try {
        // Enviar solicitud de CBU que guarda mensaje en el chat
        const response = await fetch(`${API_URL}/api/cbu/request`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${currentToken}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            
            // Mostrar datos en el modal
            document.getElementById('cbuBankDisplay').textContent = data.cbu.bank || '-';
            document.getElementById('cbuTitularDisplay').textContent = data.cbu.titular || '-';
            document.getElementById('cbuNumberDisplay').textContent = data.cbu.number || '-';
            document.getElementById('cbuAliasDisplay').textContent = data.cbu.alias || '-';
            
            showModal('cbuModal');
            
            // Recargar mensajes para mostrar el mensaje de CBU en el chat
            setTimeout(() => loadMessages(), 500);
            
            showToast('💳 Datos CBU enviados al chat', 'success');
        } else {
            showToast('Error solicitando CBU', 'error');
        }
    } catch (error) {
        console.error('Error solicitando CBU:', error);
        showToast('Error de conexión', 'error');
    }
}

function copyToClipboard(elementId) {
    const element = document.getElementById(elementId);
    const text = element.textContent;
    
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('📋 Copiado al portapapeles', 'success');
        }).catch(() => {
            // Fallback
            fallbackCopy(text);
        });
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    
    try {
        document.execCommand('copy');
        showToast('📋 Copiado al portapapeles', 'success');
    } catch (err) {
        showToast('Error al copiar', 'error');
    }
    
    document.body.removeChild(textarea);
}

// ========================================
// CANAL INFORMATIVO
// ========================================

async function loadCanalInformativoUrl() {
    try {
        const response = await fetch(`${API_URL}/api/config/canal-url`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!response.ok) return;
        const data = await response.json();
        const btn = document.getElementById('canalInformativoBtn');
        if (!btn) return;
        if (data.url) {
            btn.href = data.url;
            btn.style.display = 'inline-flex';
        } else {
            btn.style.display = 'none';
        }
    } catch {
        // Si no hay URL configurada, ocultar el botón silenciosamente
        const btn = document.getElementById('canalInformativoBtn');
        if (btn) btn.style.display = 'none';
    }
}

// ========================================
// SONIDO DE NOTIFICACIÓN
// ========================================

let notificationAudioContext = null;

function initNotificationSound() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
            notificationAudioContext = new AudioContext();
        }
    } catch (e) {
        console.log('AudioContext no soportado');
    }
}

function playNotificationSound() {
    if (!notificationAudioContext) {
        initNotificationSound();
    }
    
    try {
        if (notificationAudioContext) {
            const oscillator = notificationAudioContext.createOscillator();
            const gainNode = notificationAudioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(notificationAudioContext.destination);
            
            oscillator.frequency.value = 600;
            oscillator.type = 'sine';
            
            gainNode.gain.setValueAtTime(0.3, notificationAudioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, notificationAudioContext.currentTime + 0.4);
            
            oscillator.start(notificationAudioContext.currentTime);
            oscillator.stop(notificationAudioContext.currentTime + 0.4);
        }
    } catch (e) {
        console.log('Error reproduciendo sonido:', e);
    }
}

// ========================================
// CAMBIO DE CONTRASEÑA
// ========================================

// Preparar el modal de cambio de contraseña según si el usuario ya tiene teléfono
function prepareChangePasswordModal() {
    const whatsappGroup = document.getElementById('changePasswordWhatsAppGroup');
    const whatsappInfo = document.getElementById('changePasswordWhatsAppInfo');
    const whatsappInput = document.getElementById('changePasswordWhatsApp');
    const existingPhone = currentUser && (currentUser.whatsapp || currentUser.phone);

    if (whatsappGroup) {
        if (existingPhone) {
            whatsappGroup.style.display = 'none';
            if (whatsappInput) whatsappInput.removeAttribute('required');
        } else {
            whatsappGroup.style.display = '';
            if (whatsappInput) whatsappInput.setAttribute('required', '');
        }
    }
    if (whatsappInfo) {
        whatsappInfo.style.display = existingPhone ? 'block' : 'none';
        whatsappInfo.textContent = existingPhone ? `✅ Teléfono ya registrado: ${existingPhone}` : '';
    }
}

async function handleChangePassword(e) {
    e.preventDefault();

    const newPassword = document.getElementById('newPasswordInput').value;
    const confirmPassword = document.getElementById('confirmPasswordInput').value;
    const whatsappInput = document.getElementById('changePasswordWhatsApp').value.trim();
    const errorDiv = document.getElementById('passwordError');

    // Si el usuario ya tiene número vinculado, no pedir uno nuevo
    const existingPhone = currentUser && (currentUser.whatsapp || currentUser.phone);
    const whatsapp = whatsappInput || existingPhone || '';
    
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
    
    if (!existingPhone && (!whatsappInput || whatsappInput.length < 8)) {
        errorDiv.textContent = 'El número de WhatsApp es obligatorio (mínimo 8 dígitos)';
        errorDiv.classList.add('show');
        return;
    }
    
    const closeAllSessions = document.getElementById('closeAllSessions').checked;
    
    try {
        const response = await fetch(`${API_URL}/api/auth/change-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ newPassword, whatsapp, closeAllSessions })
        });
        
        if (response.ok) {
            passwordChangePending = false; // Desbloquear: cambio obligatorio completado
            hideModal('changePasswordModal');
            showToast('✅ Contraseña y WhatsApp guardados exitosamente', 'success');
            // Limpiar campos
            document.getElementById('newPasswordInput').value = '';
            document.getElementById('confirmPasswordInput').value = '';
            document.getElementById('changePasswordWhatsApp').value = '';
            document.getElementById('closeAllSessions').checked = false;
            
            // Si se cerraron todas las sesiones, hacer logout
            if (closeAllSessions) {
                showToast('🔒 Todas las sesiones han sido cerradas. Por favor, vuelve a iniciar sesión.', 'info');
                setTimeout(() => {
                    localStorage.removeItem('userToken');
                    location.reload();
                }, 2000);
            }
        } else {
            const data = await response.json();
            errorDiv.textContent = data.error || 'Error al cambiar contraseña';
            errorDiv.classList.add('show');
        }
    } catch (error) {
        errorDiv.textContent = 'Error de conexión';
        errorDiv.classList.add('show');
    }
}

// ========================================
// BUSCAR USUARIO POR TELÉFONO
// ========================================

async function handleFindUserByPhone(e) {
    e.preventDefault();
    
    const phone = document.getElementById('findUserPhone').value.trim();
    const resultDiv = document.getElementById('findUserResult');
    
    if (!phone || phone.length < 8) {
        resultDiv.textContent = 'Ingresa un número de teléfono válido (mínimo 8 dígitos)';
        resultDiv.style.background = 'rgba(255, 68, 68, 0.2)';
        resultDiv.style.color = '#ff4444';
        resultDiv.style.display = 'block';
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/auth/find-user-by-phone`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
        });
        
        const data = await response.json();
        
        if (data.found) {
            resultDiv.innerHTML = `
                <div style="text-align: center;">
                    <p style="color: #00ff88; font-size: 18px; font-weight: bold; margin-bottom: 10px;">✅ Usuario encontrado!</p>
                    <p style="font-size: 24px; font-weight: bold; color: #d4af37; margin: 10px 0;">${escapeHtml(data.username)}</p>
                    <p style="color: #888; font-size: 12px;">Teléfono: ${escapeHtml(data.phone || 'No registrado')}</p>
                </div>
            `;
            resultDiv.style.background = 'rgba(0, 255, 136, 0.2)';
            resultDiv.style.color = '#00ff88';
        } else {
            resultDiv.innerHTML = `
                <div style="text-align: center;">
                    <p style="color: #ff4444; font-size: 16px; font-weight: bold;">❌ ${escapeHtml(data.message)}</p>
                    <p style="color: #888; font-size: 12px; margin-top: 10px;">Verifica que el número sea correcto</p>
                </div>
            `;
            resultDiv.style.background = 'rgba(255, 68, 68, 0.2)';
            resultDiv.style.color = '#ff4444';
        }
        resultDiv.style.display = 'block';
    } catch (error) {
        resultDiv.textContent = 'Error de conexión. Intenta más tarde.';
        resultDiv.style.background = 'rgba(255, 68, 68, 0.2)';
        resultDiv.style.color = '#ff4444';
        resultDiv.style.display = 'block';
    }
}

// ========================================
// CAMBIAR CONTRASEÑA POR TELÉFONO
// ========================================

async function handleResetPasswordByPhone(e) {
    e.preventDefault();
    
    const phone = document.getElementById('resetPassPhone').value.trim();
    const newPassword = document.getElementById('resetPassNew').value;
    const confirmPassword = document.getElementById('resetPassConfirm').value;
    const resultDiv = document.getElementById('resetPassResult');
    
    if (!phone || phone.length < 8) {
        resultDiv.textContent = 'Ingresa un número de teléfono válido';
        resultDiv.style.background = 'rgba(255, 68, 68, 0.2)';
        resultDiv.style.color = '#ff4444';
        resultDiv.style.display = 'block';
        return;
    }
    
    if (newPassword.length < 6) {
        resultDiv.textContent = 'La contraseña debe tener al menos 6 caracteres';
        resultDiv.style.background = 'rgba(255, 68, 68, 0.2)';
        resultDiv.style.color = '#ff4444';
        resultDiv.style.display = 'block';
        return;
    }
    
    if (newPassword !== confirmPassword) {
        resultDiv.textContent = 'Las contraseñas no coinciden';
        resultDiv.style.background = 'rgba(255, 68, 68, 0.2)';
        resultDiv.style.color = '#ff4444';
        resultDiv.style.display = 'block';
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/auth/reset-password-by-phone`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, newPassword })
        });
        
        const data = await response.json();
        
        if (data.success) {
            resultDiv.innerHTML = `
                <div style="text-align: center;">
                    <p style="color: #00ff88; font-size: 18px; font-weight: bold; margin-bottom: 10px;">✅ Contraseña cambiada!</p>
                    <p style="font-size: 16px; color: #d4af37; margin: 10px 0;">Usuario: ${escapeHtml(data.username)}</p>
                    <p style="color: #888; font-size: 12px;">Ya puedes iniciar sesión con tu nueva contraseña</p>
                </div>
            `;
            resultDiv.style.background = 'rgba(0, 255, 136, 0.2)';
            resultDiv.style.color = '#00ff88';
            // Limpiar campos
            document.getElementById('resetPassPhone').value = '';
            document.getElementById('resetPassNew').value = '';
            document.getElementById('resetPassConfirm').value = '';
        } else {
            resultDiv.innerHTML = `
                <div style="text-align: center;">
                    <p style="color: #ff4444; font-size: 16px; font-weight: bold;">❌ ${escapeHtml(data.error)}</p>
                </div>
            `;
            resultDiv.style.background = 'rgba(255, 68, 68, 0.2)';
            resultDiv.style.color = '#ff4444';
        }
        resultDiv.style.display = 'block';
    } catch (error) {
        resultDiv.textContent = 'Error de conexión. Intenta más tarde.';
        resultDiv.style.background = 'rgba(255, 68, 68, 0.2)';
        resultDiv.style.color = '#ff4444';
        resultDiv.style.display = 'block';
    }
}

// ========================================
// DEPÓSITO Y RETIRO
// ========================================

async function handleDeposit(e) {
    e.preventDefault();
    
    const amount = parseFloat(document.getElementById('depositAmount').value);
    const errorDiv = document.getElementById('depositError');
    
    if (!amount || amount < 100) {
        errorDiv.textContent = 'El monto mínimo es $100';
        errorDiv.classList.add('show');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/movements/deposit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ amount })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            hideModal('depositModal');
            const newBalance = data.newBalance || 0;
            showToast(`✅ Depósito de $${amount.toLocaleString()} realizado\n💰 Saldo actual: $${newBalance.toLocaleString()}`, 'success');
            document.getElementById('depositAmount').value = '';
            // Enviar mensaje automático
            await sendSystemMessage(`💰 Depósito realizado: $${amount.toLocaleString()}\n💰 Saldo actual: $${newBalance.toLocaleString()}`);
        } else {
            errorDiv.textContent = data.error || 'Error al realizar depósito';
            errorDiv.classList.add('show');
        }
    } catch (error) {
        errorDiv.textContent = 'Error de conexión';
        errorDiv.classList.add('show');
    }
}

async function handleWithdraw(e) {
    e.preventDefault();
    
    const amount = parseFloat(document.getElementById('withdrawAmount').value);
    const errorDiv = document.getElementById('withdrawError');
    
    if (!amount || amount < 100) {
        errorDiv.textContent = 'El monto mínimo es $100';
        errorDiv.classList.add('show');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/movements/withdraw`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ amount })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            hideModal('withdrawModal');
            showToast(`✅ Retiro de $${amount.toLocaleString()} realizado`, 'success');
            document.getElementById('withdrawAmount').value = '';
            // Enviar mensaje automático
            await sendSystemMessage(`💸 Retiro realizado: $${amount.toLocaleString()}`);
        } else {
            errorDiv.textContent = data.error || 'Error al realizar retiro';
            errorDiv.classList.add('show');
        }
    } catch (error) {
        errorDiv.textContent = 'Error de conexión';
        errorDiv.classList.add('show');
    }
}

async function sendSystemMessage(content) {
    try {
        await fetch(`${API_URL}/api/messages/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ content, type: 'text' })
        });
        loadMessages();
    } catch (error) {
        console.error('Error enviando mensaje de sistema:', error);
    }
}

// ========================================
// LIGHTBOX - Visor de imágenes
// ========================================

function openLightbox(src) {
    const lightbox = document.getElementById('lightbox');
    const lightboxImage = document.getElementById('lightboxImage');
    lightboxImage.src = src;
    lightbox.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeLightbox(event) {
    // Cerrar si se hace clic fuera de la imagen o en el botón de cerrar
    if (event.target.id === 'lightbox' || event.target.classList.contains('lightbox-close')) {
        const lightbox = document.getElementById('lightbox');
        lightbox.classList.remove('active');
        document.body.style.overflow = '';
    }
}

// Cerrar lightbox con tecla Escape
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        // Si hay cambio de contraseña pendiente, bloquear Escape
        if (passwordChangePending) {
            e.preventDefault();
            return;
        }
        const lightbox = document.getElementById('lightbox');
        if (lightbox.classList.contains('active')) {
            lightbox.classList.remove('active');
            document.body.style.overflow = '';
        }
    }
});

// ========================================
// SOCKET.IO - Conexión en tiempo real
// ========================================

let socket = null;

function initSocket() {
    if (socket && socket.connected) return;

    // Si el socket existe pero está desconectado, reconectarlo
    if (socket && !socket.connected) {
        socket.connect();
        return;
    }

    console.log('🔄 Inicializando socket...');

    // Configurar socket con reconexión automática (websocket únicamente para mayor velocidad)
    socket = io({
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
    });
    
    // Manejar conexión
    socket.on('connect', function() {
        console.log('✅ Socket conectado - ID:', socket.id);
        // Autenticar después de conectar
        socket.emit('authenticate', currentToken);
    });
    
    socket.on('authenticated', function(data) {
        if (data.success) {
            console.log('✅ Socket autenticado como:', data.role);
            // Unirse a la sala personal del usuario
            if (currentUser && currentUser.userId) {
                socket.emit('join_user_room', { userId: currentUser.userId });
                console.log('📢 Unido a sala personal:', currentUser.userId);
            }
            // Cargar historial de mensajes desde MongoDB al autenticar el socket
            loadMessages(true);
        } else {
            console.error('❌ Error autenticando socket:', data.error);
        }
    });
    
    // Escuchar reconexión
    socket.on('reconnect', function(attemptNumber) {
        console.log('🔄 Socket reconectado (intento:', attemptNumber + ')');
        socket.emit('authenticate', currentToken);
        // CORREGIDO: Recargar mensajes después de reconectar
        setTimeout(() => {
            loadMessages(true);
        }, 500);
    });
    
    socket.on('reconnect_attempt', function(attemptNumber) {
        console.log('🔄 Intentando reconectar... (intento:', attemptNumber + ')');
    });
    
    // CORREGIDO: Manejar errores de conexión
    socket.on('connect_error', function(error) {
        console.error('❌ Error de conexión:', error);
    });
    
    socket.on('reconnect_error', function(error) {
        console.error('❌ Error de reconexión:', error);
    });
    
    // Escuchar cuando un admin está escribiendo
    socket.on('admin_typing', function(data) {
        const typingIndicator = document.getElementById('typingIndicator');
        if (typingIndicator) {
            typingIndicator.style.display = 'inline';
            typingIndicator.textContent = '✍️ ' + (data.adminName || 'Agente') + ' está escribiendo...';
        }
    });
    
    // CORREGIDO: Escuchar notificaciones push del admin
    socket.on('push_notification', function(data) {
        console.log('📱 Notificación push recibida:', data);
        
        // Mostrar notificación del navegador
        showBrowserNotification(
            data.title || 'Nueva notificación',
            data.body || '',
            data.icon || '/favicon.ico'
        );
        
        // Reproducir sonido de notificación
        playNotificationSound();
    });
    
    // Escuchar cuando un admin deja de escribir
    socket.on('admin_stop_typing', function(data) {
        const typingIndicator = document.getElementById('typingIndicator');
        if (typingIndicator) {
            typingIndicator.style.display = 'none';
        }
    });
    
    // Escuchar nuevos mensajes - CORREGIDO para evitar duplicados y scroll automático
    socket.on('new_message', function(data) {
        console.log('📨 NEW_MESSAGE event received:', data);
        console.log('📨 Message content:', data.message?.content?.substring(0, 50) || data.content?.substring(0, 50));
        console.log('📨 Sender role:', data.message?.senderRole || data.senderRole);
        const message = data.message || data;

        // No mostrar mensajes internos/admin al usuario final
        if (message.adminOnly) return;
        
        // CORREGIDO: Verificar si el mensaje ya fue procesado (evitar duplicados)
        if (message.id && processedMessageIds.has(message.id)) {
            console.log('⚠️ Mensaje ya procesado, ignorando:', message.id);
            return;
        }
        
        // Verificar si el mensaje ya existe en el DOM
        const existingMsg = document.querySelector(`[data-message-id="${message.id}"]`);
        if (existingMsg) {
            console.log('⚠️ Mensaje ya existe en el DOM, ignorando:', message.id);
            return;
        }
        
        // CORREGIDO: Agregar ID a mensajes procesados
        if (message.id) {
            processedMessageIds.add(message.id);
            // Limpiar Set si crece demasiado (mantener últimos 100 mensajes)
            if (processedMessageIds.size > 100) {
                const iterator = processedMessageIds.values();
                processedMessageIds.delete(iterator.next().value);
            }
        }
        
        // Verificar si hay un mensaje temporal con el mismo contenido
        const tempElements = document.querySelectorAll('[data-temp-id]');
        let tempReplaced = false;
        tempElements.forEach(tempEl => {
            const tempContent = tempEl.querySelector('.message > div')?.textContent;
            const tempTime = new Date(tempEl.querySelector('.message-time')?.textContent);
            const msgTime = new Date(message.timestamp);
            if (tempContent === message.content && Math.abs(msgTime - tempTime) < 60000) {
                // Reemplazar temporal con mensaje real
                tempEl.setAttribute('data-message-id', message.id);
                tempEl.removeAttribute('data-temp-id');
                tempEl.classList.add('message-saved');
                const msgDiv = tempEl.querySelector('.message');
                if (msgDiv) {
                    msgDiv.style.opacity = '1';
                    msgDiv.style.border = '';
                }
                tempReplaced = true;
                console.log('✅ Mensaje temporal reemplazado:', message.id);
            }
        });
        
        // Si no reemplazamos un temporal, agregar el mensaje nuevo
        if (!tempReplaced) {
            addMessageToChat(message);
            playNotificationSound();
            
            // CORREGIDO: Mostrar notificación del navegador para mensajes de admin
            const adminRoles = ['admin', 'depositor', 'withdrawer'];
            const isFromAdmin = adminRoles.includes(message.senderRole);
            if (isFromAdmin) {
                const senderName = message.senderUsername || 'Soporte';
                const messagePreview = message.type === 'image' ? '📸 Imagen' : (message.content?.substring(0, 50) + '...');
                showBrowserNotification(
                    `💬 Nuevo mensaje de ${senderName}`,
                    messagePreview,
                    '/favicon.ico'
                );
            }
        }
        
        // CORREGIDO: Scroll automático SIEMPRE para TODOS los mensajes
        requestAnimationFrame(() => {
            scrollToBottom();
            setTimeout(scrollToBottom, 50);
            setTimeout(scrollToBottom, 150);
            setTimeout(scrollToBottom, 300);
        });
        
        // Actualizar el último ID de mensaje
        lastMessageId = message.id;
    });
    
    // Escuchar confirmación de mensaje enviado: solo actualizar el ID temporal
    socket.on('message_sent', function(data) {
        console.log('✅ Mensaje enviado confirmado:', data?.id);
        // Actualizar el mensaje temporal con el ID real del servidor
        if (data && data.id) {
            const tempEl = document.querySelector('[data-temp-id]');
            if (tempEl) {
                tempEl.setAttribute('data-message-id', data.id);
                tempEl.removeAttribute('data-temp-id');
                tempEl.classList.add('message-saved');
                const msgDiv = tempEl.querySelector('.message');
                if (msgDiv) {
                    msgDiv.style.opacity = '1';
                    msgDiv.style.border = '';
                }
            }
            // Registrar ID como procesado para evitar duplicados del evento new_message
            processedMessageIds.add(data.id);
        }
    });
    
    // Manejar errores
    socket.on('error', function(data) {
        console.error('❌ Error de socket:', data);
    });

    // Manejar rate limiting de mensajes
    socket.on('rate_limited', function(data) {
        showToast(data.message || 'Estás enviando mensajes muy rápido. Esperá un momento.', 'info');
    });
    
    // Manejar desconexión
    socket.on('disconnect', function() {
        console.log('🔌 Socket desconectado');
    });
}

// ========================================
// CHAT - POLLING OPTIMIZADO
// ========================================

let isLoadingMessages = false;
let lastMessagesHash = ''; // Para evitar re-renderizar si no hay cambios

function startMessagePolling() {
    loadMessages();
    // Polling de respaldo: cada 8 segundos (el socket maneja los mensajes en tiempo real)
    messageCheckInterval = setInterval(loadMessages, 8000);
    initSocket();
}

function stopMessagePolling() {
    if (messageCheckInterval) {
        clearInterval(messageCheckInterval);
        messageCheckInterval = null;
    }
    if (socket) {
        socket.disconnect();
        socket = null;
    }
}

async function loadMessages(force = false) {
    // Evitar cargas simultáneas
    if (isLoadingMessages && !force) return;
    // Verificar que el usuario esté cargado
    if (!currentUser || !currentUser.userId) return;

    isLoadingMessages = true;
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 segundos timeout
        
        console.log('[loadMessages] Cargando mensajes para:', currentUser.userId);
        
        const response = await fetch(`${API_URL}/api/messages/${currentUser.userId}?limit=15`, {
            headers: { 'Authorization': `Bearer ${currentToken}` },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (response.ok) {
            const data = await response.json();
            const messages = data.messages || []; // Extraer array de mensajes
            
            console.log('[loadMessages] Mensajes recibidos:', messages.length);
            if (messages.length > 0) {
                console.log('[loadMessages] Primer mensaje:', messages[0].content.substring(0, 30));
                console.log('[loadMessages] Último mensaje:', messages[messages.length-1].content.substring(0, 30));
            }
            
            // Calcular hash de mensajes para evitar re-renderizado innecesario
            const messagesHash = messages.map(m => m.id).join(',');
            if (messagesHash !== lastMessagesHash || force) {
                lastMessagesHash = messagesHash;
                renderMessages(messages);
            }
        } else {
            console.error('[loadMessages] Error en respuesta:', response.status);
        }
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('Error cargando mensajes:', error);
        }
    } finally {
        isLoadingMessages = false;
    }
}

function renderMessages(messages) {
    const container = document.getElementById('chatMessages');
    // Issue #1: En la carga inicial (hash vacío), siempre hacer scroll al final
    const isInitialLoad = lastMessagesHash === '';
    const wasAtBottom = isInitialLoad || (container.scrollHeight - container.scrollTop - container.clientHeight) < 60;

    // Usar DocumentFragment para mínimo reflow DOM
    const fragment = document.createDocumentFragment();
    processedMessageIds.clear();

    messages.forEach(msg => {
        if (msg.id) processedMessageIds.add(msg.id);
        const wrapper = createMessageElement(msg);
        if (wrapper) fragment.appendChild(wrapper);
    });

    container.innerHTML = '';
    container.appendChild(fragment);

    // Detectar mensajes nuevos del admin para reproducir sonido
    if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        const adminRoles = ['admin', 'depositor', 'withdrawer'];
        if (lastMessageId && lastMessageId !== lastMsg.id && adminRoles.includes(lastMsg.senderRole)) {
            playNotificationSound();
        }
        lastMessageId = lastMsg.id;
    }

    // Scroll automático al final solo si estaba cerca del fondo
    if (wasAtBottom) {
        requestAnimationFrame(() => scrollToBottom());
    }
}

// Crea el elemento DOM de un mensaje (sin agregarlo al contenedor)
function createMessageElement(message) {
    // No mostrar mensajes internos/admin al usuario final
    if (message.adminOnly) return null;

    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    const isFromUser = message.senderRole === 'user';

    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper';
    if (message.id && message.id.startsWith('temp-')) {
        wrapper.setAttribute('data-temp-id', message.id);
    } else if (message.id) {
        wrapper.setAttribute('data-message-id', message.id);
    }

    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isFromUser ? 'agente' : 'usuario'}`;

    const time = new Date(message.timestamp).toLocaleTimeString('es-AR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Argentina/Buenos_Aires'
    });

    let contentHtml = '';
    if (message.type === 'image') {
        const safeUrl = encodeURI(message.content);
        const jsonUrl = JSON.stringify(safeUrl);
        contentHtml = `<img src="${safeUrl}" onclick="openLightbox(${jsonUrl})" loading="lazy">`;
    } else if (message.type === 'video') {
        const safeUrl = encodeURI(message.content);
        contentHtml = `<video src="${safeUrl}" controls preload="metadata" style="max-width:100%;max-height:300px;border-radius:8px;"></video>`;
    } else {
        let content = escapeHtml(message.content);
        const urlRegex = /(https?:\/\/[^\s<]+[^\s<.,;:!?])/g;
        content = content.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" class="chat-link">$1</a>');
        content = content.replace(/\n/g, '<br>');
        contentHtml = `<div style="white-space: pre-wrap;">${content}</div>`;
    }

    msgDiv.innerHTML = `${contentHtml}<span class="message-time">${time}</span>`;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.innerHTML = '📋';
    copyBtn.onclick = () => copyText(message.type === 'image' ? '[Imagen]' : message.type === 'video' ? '[Video]' : message.content);

    wrapper.appendChild(msgDiv);
    wrapper.appendChild(copyBtn);
    return wrapper;
}

function addMessageToChat(message) {
    const container = document.getElementById('chatMessages');

    // Verificar si el mensaje ya existe en el DOM (evitar duplicados)
    if (message.id) {
        const existingById = container.querySelector(`[data-message-id="${message.id}"]`);
        if (existingById) {
            return;
        }
        // También verificar por temp-id
        const existingByTemp = container.querySelector(`[data-temp-id="${message.id}"]`);
        if (existingByTemp) {
            existingByTemp.setAttribute('data-message-id', message.id);
            existingByTemp.removeAttribute('data-temp-id');
            return;
        }
    }

    const wrapper = createMessageElement(message);
    container.appendChild(wrapper);

    // Scroll automático al agregar mensaje
    requestAnimationFrame(() => scrollToBottom());
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const content = input.value.trim();
    
    if (!content) return;

    // Los usuarios no pueden enviar comandos (mensajes que comiencen con /)
    if (content.startsWith('/')) {
        showToast('No puedes enviar comandos', 'error');
        input.value = '';
        input.style.height = 'auto';
        return;
    }

    // Rate limiting frontend: máximo 2 mensajes por segundo
    const now = Date.now();
    const recentTimestamps = sentMessageTimestamps.filter(t => now - t < FRONTEND_MSG_RATE_WINDOW_MS);
    if (recentTimestamps.length >= FRONTEND_MSG_RATE_MAX) {
        showToast('Estás enviando mensajes muy rápido. Esperá un momento.', 'info');
        input.value = '';
        input.style.height = 'auto';
        return;
    }
    sentMessageTimestamps.length = 0;
    sentMessageTimestamps.push(...recentTimestamps, now);
    
    // Verificar si ya se envió un mensaje idéntico en los últimos 3 segundos
    if (now - lastSentMessageTimestamp < 3000) {
        const recentContent = pendingSentMessages.get(content);
        if (recentContent && (now - recentContent) < 3000) {
            input.value = '';
            input.style.height = 'auto';
            return;
        }
    }
    pendingSentMessages.set(content, now);
    
    // Limpiar mensajes pendientes antiguos (más de 10 segundos)
    for (const [msg, timestamp] of pendingSentMessages.entries()) {
        if (now - timestamp > 10000) {
            pendingSentMessages.delete(msg);
        }
    }
    
    // Mostrar mensaje inmediatamente (optimistic UI)
    const tempId = 'temp-' + now;
    const tempMessage = {
        id: tempId,
        senderId: currentUser.userId,
        senderUsername: currentUser.username,
        senderRole: 'user',
        content: content,
        type: 'text',
        timestamp: new Date().toISOString()
    };
    addMessageToChat(tempMessage);
    
    // Limpiar input inmediatamente para mejor UX
    input.value = '';
    input.style.height = 'auto';
    
    // CORREGIDO: Scroll inmediato al enviar
    scrollToBottom();
    setTimeout(scrollToBottom, 100);
    setTimeout(scrollToBottom, 300);
    
    // Intentar enviar por socket primero (más rápido)
    if (socket && socket.connected) {
        console.log('📤 Enviando mensaje por socket...');
        socket.emit('send_message', { content, type: 'text' });
        // El socket confirmará con message_sent y new_message
        return;
    }
    
    // Fallback a REST API si el socket no está disponible
    console.log('📤 Enviando mensaje por REST API...');
    try {
        const response = await fetch(`${API_URL}/api/messages/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ content, type: 'text' })
        });
        
        if (response.ok) {
            const savedMessage = await response.json();
            console.log('✅ Mensaje guardado:', savedMessage);
            // Actualizar el ID del mensaje temporal
            const tempMsgElement = document.querySelector(`[data-temp-id="${tempId}"]`);
            if (tempMsgElement) {
                tempMsgElement.setAttribute('data-message-id', savedMessage.id);
                tempMsgElement.removeAttribute('data-temp-id');
                tempMsgElement.classList.add('message-saved');
            }
            // CORREGIDO: Scroll después de confirmar
            scrollToBottom();
        } else {
            // Si falla, marcar el mensaje como error
            const tempMsgElement = document.querySelector(`[data-temp-id="${tempId}"]`);
            if (tempMsgElement) {
                tempMsgElement.classList.add('message-error');
                const msgDiv = tempMsgElement.querySelector('.message');
                if (msgDiv) {
                    msgDiv.style.opacity = '0.5';
                    msgDiv.style.border = '1px solid #ff4444';
                }
            }
            showToast('Error al enviar mensaje', 'error');
        }
    } catch (error) {
        console.error('❌ Error enviando mensaje:', error);
        const tempMsgElement = document.querySelector(`[data-temp-id="${tempId}"]`);
        if (tempMsgElement) {
            tempMsgElement.classList.add('message-error');
            const msgDiv = tempMsgElement.querySelector('.message');
            if (msgDiv) {
                msgDiv.style.opacity = '0.5';
                msgDiv.style.border = '1px solid #ff4444';
            }
        }
        showToast('Error de conexión', 'error');
    }
}

// Manejar selección de archivo (imágenes y videos)
async function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) {
        showToast('Solo se permiten imágenes o videos', 'error');
        return;
    }
    
    if (file.size > 100 * 1024 * 1024) {
        showToast('El archivo es muy grande. Máximo 100MB', 'error');
        return;
    }

    const fileType = isVideo ? 'video' : 'image';
    const fileLabel = isVideo ? '🎥 Video' : '📸 Imagen';

    const sendingIndicator = document.getElementById('sendingIndicator');
    if (sendingIndicator) {
        sendingIndicator.style.display = 'block';
    }
    
    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            const tempMessage = {
                id: 'temp-' + fileType + '-' + Date.now(),
                senderId: currentUser?.id || 'me',
                senderUsername: currentUser?.username || 'Yo',
                senderRole: 'user',
                content: event.target.result,
                timestamp: new Date(),
                type: fileType
            };
            addMessageToChat(tempMessage);
            scrollToBottom();
            
            const response = await fetch(`${API_URL}/api/messages/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentToken}`
                },
                body: JSON.stringify({
                    content: event.target.result,
                    type: fileType
                })
            });
            
            if (response.ok) {
                loadMessages();
                showToast(`${fileLabel} enviada`, 'success');
            }
        } catch (error) {
            console.error('Error enviando archivo:', error);
            showToast('Error al enviar archivo', 'error');
        } finally {
            if (sendingIndicator) {
                sendingIndicator.style.display = 'none';
            }
            e.target.value = '';
        }
    };
    reader.onerror = () => {
        showToast('Error al leer el archivo', 'error');
        if (sendingIndicator) {
            sendingIndicator.style.display = 'none';
        }
        e.target.value = '';
    };
    reader.readAsDataURL(file);
}

// Pegar imagen con Ctrl+V desde portapapeles (escritorio)
async function handlePaste(e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;

    for (const item of items) {
        if (item.type.startsWith('image/')) {
            e.preventDefault(); // No insertar texto de la imagen en el textarea
            const file = item.getAsFile();
            if (!file) continue;

            if (file.size > 100 * 1024 * 1024) {
                showToast('La imagen es muy grande. Máximo 100MB', 'error');
                return;
            }

            const sendingIndicator = document.getElementById('sendingIndicator');
            if (sendingIndicator) sendingIndicator.style.display = 'block';

            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const tempMessage = {
                        id: 'temp-image-' + Date.now(),
                        senderId: currentUser?.id || 'me',
                        senderUsername: currentUser?.username || 'Yo',
                        senderRole: 'user',
                        content: event.target.result,
                        timestamp: new Date(),
                        type: 'image'
                    };
                    addMessageToChat(tempMessage);
                    scrollToBottom();

                    const response = await fetch(`${API_URL}/api/messages/send`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${currentToken}`
                        },
                        body: JSON.stringify({ content: event.target.result, type: 'image' })
                    });

                    if (response.ok) {
                        loadMessages();
                        showToast('📸 Imagen enviada', 'success');
                    }
                } catch (error) {
                    console.error('Error enviando imagen pegada:', error);
                    showToast('Error al enviar imagen', 'error');
                } finally {
                    if (sendingIndicator) sendingIndicator.style.display = 'none';
                }
            };
            reader.onerror = () => {
                showToast('Error al leer la imagen', 'error');
                if (sendingIndicator) sendingIndicator.style.display = 'none';
            };
            reader.readAsDataURL(file);
            break; // Solo procesar la primera imagen
        }
    }
}


function scrollToBottom() {
    const container = document.getElementById('chatMessages');
    if (container) {
        // CORREGIDO: Scroll suave al final del contenedor
        container.scrollTo({
            top: container.scrollHeight,
            behavior: 'smooth'
        });
        // Asegurar que llegue al final
        container.scrollTop = container.scrollHeight;
    }
}

// ========================================
// NOTIFICACIONES DEL NAVEGADOR - CORREGIDO
// ========================================

// CORREGIDO: Solicitar permiso para notificaciones del navegador
function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
            console.log('🔔 Permiso de notificación:', permission);
        });
    }
}

// CORREGIDO: Mostrar notificación del navegador
function showBrowserNotification(title, body, icon = '/favicon.ico') {
    if ('Notification' in window && Notification.permission === 'granted') {
        try {
            const notification = new Notification(title, {
                body: body,
                icon: icon,
                badge: icon,
                tag: 'new-message',
                requireInteraction: false,
                silent: false
            });
            
            notification.onclick = () => {
                window.focus();
                notification.close();
            };
            
            // Cerrar automáticamente después de 5 segundos
            setTimeout(() => notification.close(), 5000);
        } catch (e) {
            console.log('No se pudo mostrar notificación:', e);
        }
    }
}

// ========================================
// REEMBOLSOS
// ========================================

async function loadRefundStatus() {
    try {
        const response = await fetch(`${API_URL}/api/refunds/status`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            refundStatus = await response.json();
            updateRefundButtons();
        }
    } catch (error) {
        console.error('Error cargando reembolsos:', error);
    }
}

function updateRefundButtons() {
    if (!refundStatus) return;
    
    updateRefundButton('daily', refundStatus.daily);
    updateRefundButton('weekly', refundStatus.weekly);
    updateRefundButton('monthly', refundStatus.monthly);
}

function updateRefundButton(type, data) {
    const btn = document.getElementById(`${type}RefundBtn`);
    const amount = document.getElementById(`${type}RefundAmount`);
    const timer = document.getElementById(`${type}RefundTimer`);
    
    amount.textContent = `$${data.potentialAmount.toLocaleString()}`;
    
    // Botones siempre habilitados - clickeables siempre
    btn.disabled = false;
    btn.classList.remove('claimed');
    
    if (data.canClaim && data.potentialAmount > 0) {
        timer.textContent = '¡Listo!';
        btn.style.opacity = '1';
    } else {
        btn.style.opacity = '0.7';
        if (data.nextClaim) {
            startCountdown(type, data.nextClaim);
        } else {
            timer.textContent = 'Ver info';
        }
    }
}

function startCountdown(type, targetDate) {
    const timerElement = document.getElementById(`${type}RefundTimer`);
    
    function update() {
        const now = getArgentinaDate();
        const target = new Date(targetDate);
        const diff = target - now;
        
        if (diff <= 0) {
            timerElement.textContent = '¡Listo!';
            loadRefundStatus();
            return;
        }
        
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        
        if (hours > 24) {
            timerElement.textContent = `${Math.floor(hours/24)}d`;
        } else {
            timerElement.textContent = `${hours}h ${minutes}m`;
        }
    }
    
    update();
    if (refundTimers[type]) clearInterval(refundTimers[type]);
    refundTimers[type] = setInterval(update, 60000);
}

async function showRefundModal(type) {
    console.log('🎁 Abriendo modal de reembolso:', type);
    console.log('📊 refundStatus:', refundStatus);
    
    // Si no hay refundStatus, intentar cargarlo primero
    if (!refundStatus) {
        console.log('🔄 refundStatus no disponible, cargando...');
        showToast('Cargando información de reembolsos...', 'info');
        await loadRefundStatus();
        
        // Si después de cargar sigue sin haber datos, mostrar error
        if (!refundStatus) {
            console.error('❌ No se pudo cargar refundStatus');
            showToast('Error: No se pudo cargar la información de reembolsos. Intenta recargar la página.', 'error');
            return;
        }
    }
    
    const typeData = refundStatus[type];
    const titles = {
        daily: '📅 Reembolso Diario (20%)',
        weekly: '📆 Reembolso Semanal (10%)',
        monthly: '🗓️ Reembolso Mensual (5%)'
    };
    
    const periodLabels = {
        daily: '📊 PÉRDIDAS DE AYER',
        weekly: '📊 PÉRDIDAS DE LA SEMANA PASADA (Lun-Dom)',
        monthly: '📊 PÉRDIDAS DEL MES PASADO'
    };
    
    document.getElementById('refundModalTitle').textContent = titles[type];
    document.getElementById('refundMovementsTitle').textContent = periodLabels[type];
    
    // Balance actual del usuario
    const currentBalance = refundStatus.user?.currentBalance || 0;
    document.getElementById('refundCurrentBalance').textContent = `$${currentBalance.toLocaleString()}`;
    
    // Período específico
    document.getElementById('refundPeriod').textContent = typeData.period || '-';
    
    // Pérdidas del período (netAmount = NETWIN = pérdidas)
    document.getElementById('refundNetAmount').textContent = `$${(typeData.netAmount || 0).toLocaleString()}`;
    document.getElementById('refundAmount').textContent = `$${(typeData.potentialAmount || 0).toLocaleString()}`;
    
    // Info de disponibilidad para semanal y mensual
    const availabilityInfo = document.getElementById('refundAvailabilityInfo');
    availabilityInfo.style.display = 'none';
    availabilityInfo.innerHTML = '';
    
    if (type === 'weekly') {
        const today = new Date().getDay(); // 0 = domingo, 1 = lunes, 2 = martes
        const isClaimableDay = today === 1 || today === 2; // Lunes o martes
        
        if (!isClaimableDay) {
            availabilityInfo.style.display = 'block';
            availabilityInfo.style.background = 'rgba(255,165,0,0.1)';
            availabilityInfo.style.border = '1px solid rgba(255,165,0,0.3)';
            availabilityInfo.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 20px;">ℹ️</span>
                    <div>
                        <p style="color: #ffa500; font-weight: bold; margin: 0; font-size: 12px;">Reembolso Semanal</p>
                        <p style="color: #ccc; margin: 0; font-size: 11px;">Solo reclamable los días <strong>LUNES y MARTES</strong></p>
                        <p style="color: #aaa; margin: 0; font-size: 10px;">Corresponde a la semana anterior (Lunes a Domingo)</p>
                    </div>
                </div>
            `;
        }
    } else if (type === 'monthly') {
        const today = new Date().getDate();
        const isClaimableDay = today >= 7; // Después del día 7
        
        if (!isClaimableDay) {
            availabilityInfo.style.display = 'block';
            availabilityInfo.style.background = 'rgba(255,165,0,0.1)';
            availabilityInfo.style.border = '1px solid rgba(255,165,0,0.3)';
            availabilityInfo.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 20px;">ℹ️</span>
                    <div>
                        <p style="color: #ffa500; font-weight: bold; margin: 0; font-size: 12px;">Reembolso Mensual</p>
                        <p style="color: #ccc; margin: 0; font-size: 11px;">Solo reclamable <strong>después del día 7</strong> de cada mes</p>
                        <p style="color: #aaa; margin: 0; font-size: 10px;">Corresponde al mes anterior completo</p>
                    </div>
                </div>
            `;
        }
    }
    
    // Info adicional
    const extraInfo = document.getElementById('refundExtraInfo');
    
    // Verificar si ya fue reclamado y calcular tiempo restante
    const claimBtn = document.getElementById('claimRefundBtn');
    let isClaimed = false;
    let timeRemaining = '';
    
    if (typeData.lastClaim) {
        const lastClaim = new Date(typeData.lastClaim);
        const now = new Date();
        
        if (type === 'daily') {
            const tomorrow = new Date(lastClaim);
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(0, 0, 0, 0);
            if (now < tomorrow) {
                isClaimed = true;
                const diff = tomorrow - now;
                const hours = Math.floor(diff / (1000 * 60 * 60));
                const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                timeRemaining = `${hours}h ${minutes}m`;
            }
        } else if (type === 'weekly') {
            const nextMonday = new Date(lastClaim);
            const daysUntilMonday = (8 - lastClaim.getDay()) % 7 || 7;
            nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
            nextMonday.setHours(0, 0, 0, 0);
            if (now < nextMonday) {
                isClaimed = true;
                const diff = nextMonday - now;
                const days = Math.floor(diff / (1000 * 60 * 60 * 24));
                const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                timeRemaining = `${days}d ${hours}h`;
            }
        } else if (type === 'monthly') {
            const nextMonth = new Date(lastClaim.getFullYear(), lastClaim.getMonth() + 1, 7);
            nextMonth.setHours(0, 0, 0, 0);
            if (now < nextMonth) {
                isClaimed = true;
                const diff = nextMonth - now;
                const days = Math.floor(diff / (1000 * 60 * 60 * 24));
                timeRemaining = `${days}d`;
            }
        }
    }
    
    if (typeData.potentialAmount <= 0) {
        extraInfo.innerHTML = '<span style="color: #ff8888;">⚠️ No tienes saldo neto positivo para reclamar reembolso</span>';
        claimBtn.disabled = true;
        claimBtn.textContent = '❌ Sin saldo para reembolso';
        claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
    } else if (isClaimed) {
        extraInfo.innerHTML = `<span style="color: #ffaa44;">⏳ Ya reclamaste este reembolso. Disponible en: <strong>${timeRemaining}</strong></span>`;
        claimBtn.disabled = true;
        claimBtn.textContent = `⏳ Disponible en ${timeRemaining}`;
        claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
    } else if (!typeData.canClaim) {
        extraInfo.innerHTML = '<span style="color: #ffaa44;">⏳ No puedes reclamar este reembolso en este momento.</span>';
        claimBtn.disabled = true;
        claimBtn.textContent = '⏳ No disponible';
        claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
    } else {
        extraInfo.innerHTML = '<span style="color: #00ff88;">✅ ¡Puedes reclamar este reembolso!</span>';
        claimBtn.disabled = false;
        claimBtn.textContent = '🎁 Reclamar Reembolso';
        claimBtn.style.background = '';
    }
    
    claimBtn.onclick = () => claimRefund(type);
    
    showModal('refundModal');
}

async function claimRefund(type) {
    // Proteger botón contra doble click
    const claimBtn = document.getElementById('claimRefundBtn');
    if (claimBtn) {
        if (claimBtn.disabled) return;
        claimBtn.disabled = true;
        claimBtn.textContent = '⏳ Procesando...';
    }
    try {
        const response = await fetch(`${API_URL}/api/refunds/claim/${type}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast(`✅ ${data.message}`, 'success');
            hideModal('refundModal');
            loadRefundStatus();
            sendSystemMessage(`🎁 Reembolso ${type} reclamado: $${data.amount.toLocaleString()}`);
        } else {
            // Mostrar mensaje informativo (no error)
            showToast(`ℹ️ ${data.message}`, 'info');
            hideModal('refundModal');
            loadRefundStatus();
        }
    } catch (error) {
        showToast('Error de conexión', 'error');
    } finally {
        if (claimBtn) {
            claimBtn.disabled = false;
            claimBtn.textContent = '🎁 Reclamar Reembolso';
        }
    }
}

// ========================================
// FUEGUITO (RACHA DIARIA)
// ========================================

let fireStatus = null;

async function loadFireStatus() {
    try {
        const response = await fetch(`${API_URL}/api/fire/status`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            fireStatus = await response.json();
            updateFireButton();
        }
    } catch (error) {
        console.error('Error cargando fueguito:', error);
    }
}

function updateFireButton() {
    if (!fireStatus) return;
    
    const btn = document.getElementById('fireBtn');
    const streak = document.getElementById('fireStreak');
    
    streak.textContent = fireStatus.streak || 0;
    
    // El botón nunca se deshabilita, solo cambia la animación
    if (fireStatus.canClaim) {
        btn.style.animation = 'fire-pulse 1s ease infinite';
        btn.style.opacity = '1';
    } else {
        btn.style.animation = 'none';
        btn.style.opacity = '0.7';
    }
}

async function showFireModal() {
    // Si no hay datos del fueguito, cargarlos primero
    if (!fireStatus) {
        await loadFireStatus();
    }
    
    if (!fireStatus) {
        showToast('Error cargando datos del fueguito', 'error');
        return;
    }
    
    const streak = fireStatus.streak || 0;
    document.getElementById('fireStreakModal').textContent = streak;
    document.getElementById('fireLastClaim').textContent = fireStatus.lastClaim 
        ? new Date(fireStatus.lastClaim).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
        : 'Nunca';
    
    // Actualizar barra de progreso
    const progressPercent = Math.min((streak / 10) * 100, 100);
    document.getElementById('fireProgressBar').style.width = progressPercent + '%';
    document.getElementById('fireProgressBar').textContent = progressPercent + '%';
    document.getElementById('fireProgressText').textContent = `${streak}/10 días`;
    
    const claimBtn = document.getElementById('claimFireBtn');
    const condition = document.getElementById('fireCondition');
    
    // Limpiar interval anterior
    if (fireCountdownInterval) {
        clearInterval(fireCountdownInterval);
    }

    // Condición general visible al usuario (sin revelar monto exacto)
    const activityConditionEl = document.getElementById('fireActivityCondition');
    if (activityConditionEl) {
        activityConditionEl.innerHTML = '📋 <strong>Condición:</strong> Para acceder a las recompensas Fueguito diario necesitás tener movimientos de cargas y retiros durante el mes.';
    }

    // Mostrar premio pendiente "100% próxima carga" si aplica
    const pendingBonusEl = document.getElementById('firePendingBonus');
    if (pendingBonusEl) {
        if (fireStatus.pendingNextLoadBonus) {
            pendingBonusEl.style.display = 'block';
            pendingBonusEl.innerHTML = '🎉 <strong style="color:#d4af37;">Tenés un 100% en tu próxima carga disponible!</strong> Avisale a un operador cuando quieras usarlo.';
        } else {
            pendingBonusEl.style.display = 'none';
        }
    }

    // Mostrar recompensa en efectivo pendiente si aplica (días 10, 20, 30)
    const pendingCashEl = document.getElementById('firePendingCashReward');
    if (pendingCashEl) {
        if (fireStatus.pendingCashReward && fireStatus.pendingCashReward > 0) {
            pendingCashEl.style.display = 'block';
            pendingCashEl.innerHTML = `
                <div style="margin-bottom:8px;">🎉 <strong style="color:#ffd700;">¡Tenés una recompensa de $${fireStatus.pendingCashReward.toLocaleString('es-AR')} para reclamar hoy!</strong></div>
                <div style="font-size:11px;color:#aaa;margin-bottom:10px;">${fireStatus.pendingCashRewardDesc || 'Recompensa Fueguito'}</div>
                <button id="claimFireRewardBtn" onclick="claimFireReward()" style="background:linear-gradient(135deg,#ffd700,#ff8c00);color:#111;font-weight:bold;border:none;border-radius:8px;padding:10px 22px;cursor:pointer;font-size:14px;width:100%;">
                    💰 Reclamar Recompensa
                </button>
            `;
        } else {
            pendingCashEl.style.display = 'none';
        }
    }

    // Renderizar menú de milestones/recompensas
    const milestonesEl = document.getElementById('fireMilestonesMenu');
    if (milestonesEl && fireStatus.milestones) {
        milestonesEl.innerHTML = fireStatus.milestones.map(m => {
            let statusIcon, statusLabel, statusClass;
            if (m.status === 'completed') {
                statusIcon = '✅'; statusLabel = 'Completado'; statusClass = 'milestone-done';
            } else if (m.status === 'next') {
                statusIcon = '🔓'; statusLabel = '¡Próximo!'; statusClass = 'milestone-next';
            } else {
                statusIcon = '🔒'; statusLabel = 'Bloqueado'; statusClass = 'milestone-locked';
            }
            let rewardText;
            if (m.type === 'next_load_bonus') {
                rewardText = '100% en próxima carga';
            } else {
                rewardText = m.reward ? `$${m.reward.toLocaleString('es-AR')}` : '-';
            }
            // Todos los hitos requieren actividad del mes (condición base del sistema)
            const depositReq = ' <span style="font-size:10px;color:#aaa;">(requiere actividad del mes)</span>';
            return `<div class="milestone-item ${statusClass}" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;margin:4px 0;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);">
                <span>${statusIcon} <strong>Día ${m.day}</strong>: ${rewardText}${depositReq}</span>
                <span style="font-size:11px;color:#aaa;">${statusLabel}</span>
            </div>`;
        }).join('');
    }
    
    // Sin requisitos de actividad - todos pueden reclamar
    if (fireStatus.canClaim) {
        claimBtn.disabled = false;
        claimBtn.textContent = '🔥 Reclamar Fueguito';
        claimBtn.style.background = 'linear-gradient(135deg, #ff4500 0%, #ff6347 100%)';
        condition.innerHTML = '✅ <strong style="color: #00ff88;">Podés reclamar tu fueguito hoy!</strong>';
    } else {
        claimBtn.disabled = true;
        claimBtn.textContent = '⏳ Ya reclamado';
        claimBtn.style.background = '#666';
        // Iniciar cuenta regresiva
        startFireCountdown();
    }
    
    showModal('fireModal');
}

// Cuenta regresiva del fueguito
let fireCountdownInterval = null;

function startFireCountdown() {
    if (fireCountdownInterval) {
        clearInterval(fireCountdownInterval);
    }
    
    // Calcular tiempo hasta la medianoche en Argentina
    const argentinaMidnight = getArgentinaMidnight();
    
    function updateCountdown() {
        const current = getArgentinaDate();
        const diff = argentinaMidnight - current.getTime();
        
        if (diff <= 0) {
            // Ya es medianoche en Argentina, recargar estado
            loadFireStatus();
            if (fireCountdownInterval) {
                clearInterval(fireCountdownInterval);
            }
            return;
        }
        
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);
        
        // Actualizar en el modal si está abierto
        const condition = document.getElementById('fireCondition');
        if (condition && fireStatus && !fireStatus.canClaim) {
            condition.innerHTML = '⏳ Próximo fueguito disponible en: <strong style="color: #ff4500;">' + 
                String(hours).padStart(2, '0') + ':' + 
                String(minutes).padStart(2, '0') + ':' + 
                String(seconds).padStart(2, '0') + '</strong>';
        }
    }
    
    updateCountdown();
    fireCountdownInterval = setInterval(updateCountdown, 1000);
}

async function claimFire() {
    const claimBtn = document.getElementById('claimFireBtn');
    
    // Deshabilitar botón mientras se procesa
    if (claimBtn) {
        claimBtn.disabled = true;
        claimBtn.textContent = 'Procesando...';
    }
    
    try {
        const response = await fetch(`${API_URL}/api/fire/claim`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
            showToast(`🔥 ${data.message}`, 'success');
            
            // Actualizar estado local
            fireStatus.canClaim = false;
            fireStatus.lastClaim = new Date().toISOString();
            fireStatus.streak = data.streak;
            if (data.pendingNextLoadBonus !== undefined) {
                fireStatus.pendingNextLoadBonus = data.pendingNextLoadBonus;
            }
            
            // Iniciar cuenta regresiva
            startFireCountdown();
            
            // Actualizar UI
            updateFireButton();
            
            if (data.reward > 0) {
                sendSystemMessage(`🔥🔥🔥 ¡Recompensa Fueguito día ${data.streak}! Premio: $${data.reward.toLocaleString('es-AR')}`);
            } else if (data.rewardType === 'next_load_bonus') {
                sendSystemMessage(`🎉 ¡Recompensa Fueguito día 15! Tenés 100% en tu próxima carga. Avisale a un operador cuando quieras usarlo.`);
            } else {
                sendSystemMessage(`🔥 Día ${data.streak} de racha Fueguito!`);
            }
            
            // Cerrar modal después de un momento
            setTimeout(() => {
                hideModal('fireModal');
            }, 1500);
        } else {
            showToast(data.error || data.message || 'Error', 'error');
            if (claimBtn) {
                claimBtn.disabled = false;
                claimBtn.textContent = '🔥 Reclamar Fueguito';
            }
        }
    } catch (error) {
        console.error('Error reclamando fueguito:', error);
        showToast('Error de conexión', 'error');
        if (claimBtn) {
            claimBtn.disabled = false;
            claimBtn.textContent = '🔥 Reclamar Fueguito';
        }
    }
}

async function claimFireReward() {
    const btn = document.getElementById('claimFireRewardBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Procesando...';
    }

    try {
        const response = await fetch(`${API_URL}/api/fire/claim-reward`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showToast(`🎉 ${data.message}`, 'success');
            // Actualizar estado local para limpiar la recompensa pendiente
            if (fireStatus) {
                fireStatus.pendingCashReward = 0;
                fireStatus.pendingCashRewardDay = 0;
                fireStatus.pendingCashRewardDesc = '';
            }
            // Ocultar el recuadro de recompensa
            const pendingCashEl = document.getElementById('firePendingCashReward');
            if (pendingCashEl) pendingCashEl.style.display = 'none';
            sendSystemMessage(`💰 ¡Recompensa Fueguito de $${data.reward ? data.reward.toLocaleString('es-AR') : '?'} acreditada!`);
            setTimeout(() => hideModal('fireModal'), 1500);
        } else {
            showToast(data.error || 'Error al reclamar recompensa', 'error');
            if (btn) {
                btn.disabled = false;
                btn.textContent = '💰 Reclamar Recompensa';
            }
        }
    } catch (error) {
        console.error('Error reclamando recompensa Fueguito:', error);
        showToast('Error de conexión', 'error');
        if (btn) {
            btn.disabled = false;
            btn.textContent = '💰 Reclamar Recompensa';
        }
    }
}

// ========================================
// UTILIDADES
// ========================================

function showLoginScreen() {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('chatScreen').classList.add('hidden');
}

function showChatScreen() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('chatScreen').classList.remove('hidden');
    document.getElementById('currentUser').textContent = currentUser?.username || 'Usuario';
    
    // Ajustar layout ahora que el header es visible
    adjustLayout();

    // Iniciar sincronización de saldo
    syncBalance();
    startBalancePolling();
    
    // Enviar mensaje de bienvenida
    sendWelcomeMessages();

    // Mostrar banner de notificaciones si corresponde
    showNotificationBannerIfNeeded();
}

// Mostrar banner para activar notificaciones (solo si no están activadas ni fue descartado)
function showNotificationBannerIfNeeded() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') return;
    if (localStorage.getItem('notifBannerDismissed') === 'true') return;

    const banner = document.getElementById('notifBanner');
    if (!banner) return;
    banner.style.display = 'block';

    const activateBtn = document.getElementById('notifBannerActivate');
    const closeBtn = document.getElementById('notifBannerClose');

    if (activateBtn) {
        activateBtn.onclick = async () => {
            banner.style.display = 'none';
            localStorage.setItem('notifBannerDismissed', 'true');
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                showToast('✅ ¡Notificaciones activadas! Recibirás regalos y promociones.', 'success');
                sendFcmTokenAfterLogin();
            } else {
                showToast('⚠️ No se pudo activar las notificaciones', 'info');
            }
        };
    }

    if (closeBtn) {
        closeBtn.onclick = () => {
            banner.style.display = 'none';
            localStorage.setItem('notifBannerDismissed', 'true');
        };
    }
}

// CORREGIDO: Enviar mensaje de bienvenida solo una vez por usuario (máximo 1 vez cada 24h)
// Se ejecuta al iniciar sesión para asegurar que el usuario vea el mensaje correcto
async function sendWelcomeMessages() {
    // Guardia: solo enviar si no se envió un bienvenido en las últimas 24 horas para este usuario
    const welcomeKey = 'lastWelcome_' + (currentUser?.userId || '');
    const lastWelcome = parseInt(localStorage.getItem(welcomeKey) || '0');
    const hoursSince = (Date.now() - lastWelcome) / 3600000;
    if (hoursSince < 24) {
        console.log('ℹ️ Bienvenida ya enviada recientemente, omitiendo');
        return;
    }

    const username = currentUser?.username || 'Usuario';

    // Obtener CBU activo del servidor
    let cbuNumber = 'No disponible';
    try {
        const response = await fetch(`${API_URL}/api/config/cbu`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (response.ok) {
            const cbuData = await response.json();
            cbuNumber = cbuData.number || 'No disponible';
        }
    } catch (error) {
        console.log('No se pudo obtener CBU para bienvenida:', error);
    }

    const welcomeMessage = `🎉 ¡Bienvenido a la Sala de Juegos, ${username}!

🎁 Beneficios exclusivos:
• Reembolso DIARIO del 20%
• Reembolso SEMANAL del 10%
• Reembolso MENSUAL del 5%
• Fueguito diario con recompensas
• Atención 24/7

💬 Escribe aquí para hablar con un agente.

Link de pagina: https://www.jugaygana44.bet/

CBU activo: ${cbuNumber}`;

    await sendSystemMessage(welcomeMessage);
    
    // Enviar segundo mensaje con solo el CBU para que sea fácil de copiar
    if (cbuNumber && cbuNumber !== 'No disponible') {
        await sendSystemMessage(cbuNumber);
    }
    
    localStorage.setItem(welcomeKey, Date.now().toString());
    console.log('✅ Mensaje de bienvenida enviado con CBU:', cbuNumber);
}

// Enviar mensaje de sistema al chat
async function sendSystemMessage(content) {
    try {
        await fetch(`${API_URL}/api/messages/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                content: content,
                type: 'text'
            })
        });
        // Recargar mensajes para mostrar el nuevo
        setTimeout(() => loadMessages(), 200);
    } catch (error) {
        console.error('Error enviando mensaje de sistema:', error);
    }
}

// Sincronizar saldo con el servidor
async function syncBalance() {
    if (!currentToken || !currentUser) return;
    
    try {
        const response = await fetch(`${API_URL}/api/balance/live`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            if (data.balance !== undefined) {
                currentUser.balance = data.balance;
                updateBalanceDisplay(data.balance);
                
                // Mostrar notificación si el saldo cambió significativamente
                const previousBalance = parseFloat(localStorage.getItem('lastBalance') || '0');
                const newBalance = parseFloat(data.balance);
                if (Math.abs(newBalance - previousBalance) > 0.01) {
                    localStorage.setItem('lastBalance', newBalance);
                    // Mostrar saldo en algún lugar visible
                    showBalanceToast(newBalance);
                }
            }
        }
    } catch (error) {
        console.error('Error sincronizando saldo:', error);
    }
}

// Mostrar notificación de saldo actualizado
function showBalanceToast(balance) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        top: 100px;
        right: 20px;
        background: linear-gradient(135deg, #00ff88 0%, #00cc6a 100%);
        color: #000;
        padding: 15px 25px;
        border-radius: 12px;
        font-weight: bold;
        font-size: 16px;
        z-index: 10000;
        animation: slideIn 0.3s ease;
        box-shadow: 0 5px 20px rgba(0, 255, 136, 0.4);
    `;
    toast.innerHTML = `💰 Saldo actualizado: <span style="font-size: 20px;">$${balance.toLocaleString()}</span>`;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Actualizar visualización del saldo
function updateBalanceDisplay(balance) {
    // Actualizar en el header si existe un elemento de saldo
    const balanceElement = document.getElementById('userBalance');
    if (balanceElement) {
        balanceElement.textContent = `$${balance.toLocaleString()}`;
    }
    console.log('Saldo actualizado:', balance);
}

// Iniciar polling de saldo cada 10 segundos (más frecuente para ver cambios)
function startBalancePolling() {
    if (balanceCheckInterval) {
        clearInterval(balanceCheckInterval);
    }
    balanceCheckInterval = setInterval(syncBalance, 10000);
}

// Detener polling de saldo
function stopBalancePolling() {
    if (balanceCheckInterval) {
        clearInterval(balanceCheckInterval);
        balanceCheckInterval = null;
    }
}

function showModal(modalId) {
    document.getElementById(modalId).classList.remove('hidden');
}

function hideModal(modalId) {
    // Si el cambio de contraseña es obligatorio, no permitir cerrar ese modal
    if (modalId === 'changePasswordModal' && passwordChangePending) {
        return;
    }
    document.getElementById(modalId).classList.add('hidden');
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        showToast('✅ Copiado');
    } catch (error) {
        showToast('Error al copiar', 'error');
    }
}

function showToast(message, type = 'success') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.remove(), 3000);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ========================================
// LAYOUT - AJUSTE DINÁMICO (banner debajo del header)
// ========================================

function adjustLayout() {
    const header = document.querySelector('.header');
    const promoBanner = document.querySelector('.promo-banner');
    const chatSection = document.querySelector('.chat-section');
    const inputContainer = document.querySelector('.chat-input-container');

    if (!header || !chatSection) return;

    const headerHeight = header.getBoundingClientRect().height;

    if (promoBanner) {
        const bannerComputed = window.getComputedStyle(promoBanner);
        if (bannerComputed.display !== 'none') {
            promoBanner.style.top = headerHeight + 'px';
            const bannerHeight = promoBanner.getBoundingClientRect().height;
            chatSection.style.marginTop = (headerHeight + bannerHeight) + 'px';
        } else {
            chatSection.style.marginTop = headerHeight + 'px';
        }
    } else {
        chatSection.style.marginTop = headerHeight + 'px';
    }

    // Set bottom margin dynamically based on actual input container height
    // This ensures the last message is always visible above the input bar
    if (inputContainer) {
        const inputHeight = inputContainer.getBoundingClientRect().height;
        chatSection.style.marginBottom = inputHeight + 'px';
    }
}

// ========================================
// PWA - INSTALACIÓN DE LA APP
// ========================================

// Variable global para el prompt de instalación
window.deferredPrompt = null;

// Capturar el evento beforeinstallprompt
window.addEventListener('beforeinstallprompt', (e) => {
    // No mostrar si ya estamos en modo standalone (app instalada)
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
        console.log('PWA: ya en standalone, ignorando beforeinstallprompt');
        return;
    }
    // No llamar e.preventDefault(): dejar que Chrome muestre la mini-barra
    // nativa de instalación (que crea un WebAPK real en Android).
    // Guardamos el evento para que los botones personalizados también puedan usarlo.
    window.deferredPrompt = e;
    // Mostrar los botones de instalar (login, header y app)
    const loginInstallBtn = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    const appInstallBtn = document.getElementById('appInstallBtn');
    if (loginInstallBtn) {
        loginInstallBtn.style.display = 'flex';
        loginInstallBtn.classList.remove('hidden');
    }
    if (headerInstallBtn) {
        headerInstallBtn.style.display = 'flex';
        headerInstallBtn.classList.remove('hidden');
    }
    // CORREGIDO: Mostrar botón APP en el header al lado de soporte
    if (appInstallBtn) {
        appInstallBtn.style.display = 'flex';
        appInstallBtn.classList.add('show');
    }
    console.log('PWA: beforeinstallprompt capturado, botones mostrados');
});

// Detectar cuando la app fue instalada
window.addEventListener('appinstalled', () => {
    console.log('PWA: App instalada exitosamente');
    // Ocultar los botones de instalar
    const loginInstallBtn = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    const appInstallBtn = document.getElementById('appInstallBtn');
    if (loginInstallBtn) {
        loginInstallBtn.style.display = 'none';
        loginInstallBtn.classList.add('hidden');
    }
    if (headerInstallBtn) {
        headerInstallBtn.style.display = 'none';
        headerInstallBtn.classList.add('hidden');
    }
    // Ocultar botón APP del header usando clase .hidden (anula !important del CSS)
    if (appInstallBtn) {
        appInstallBtn.classList.add('hidden');
    }
    // Limpiar el prompt guardado
    window.deferredPrompt = null;
    showToast('✅ App instalada exitosamente', 'success');
});

// Función para instalar la app
async function installApp() {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    const isAndroid = /Android/.test(ua);
    const isWindows = /Windows/.test(ua);
    const isMac = /Macintosh|MacIntel/.test(ua) && !isIOS;

    if (!window.deferredPrompt) {
        // Sin prompt nativo disponible — mostrar instrucciones específicas por plataforma
        if (isIOS) {
            showInstallInstructions('ios');
        } else if (isAndroid) {
            showInstallInstructions('android');
        } else if (isWindows) {
            showInstallInstructions('windows');
        } else if (isMac) {
            showInstallInstructions('mac');
        } else {
            showInstallInstructions('generic');
        }
        return;
    }
    
    // Mostrar el prompt de instalación (Android/Chrome nativo)
    window.deferredPrompt.prompt();
    
    const { outcome } = await window.deferredPrompt.userChoice;
    console.log('PWA: Resultado de la instalación:', outcome);
    
    if (outcome === 'accepted') {
        showToast('✅ Instalando app...', 'success');
    } else {
        showToast('❌ Instalación cancelada', 'error');
    }
    
    window.deferredPrompt = null;
}

function showInstallInstructions(platform) {
    const modal = document.createElement('div');
    modal.className = 'ios-install-modal';
    
    let title, steps, note;
    
    if (platform === 'ios') {
        title = '📱 Instalar en iPhone / iPad';
        note = '⚠️ <strong>Solo funciona desde Safari.</strong>';
        steps = [
            'Abrí esta página en <strong>Safari</strong> (no Chrome, no otro navegador)',
            'Tocá el botón <strong>Compartir</strong> <span style="font-size:18px">⬆️</span> en la barra inferior de Safari',
            'Deslizá hacia abajo y tocá <strong>"Agregar a pantalla de inicio"</strong>',
            'Presioná <strong>"Agregar"</strong>'
        ];
    } else if (platform === 'android') {
        title = '📱 Instalar en Android';
        note = '⚠️ <strong>Solo funciona desde Google Chrome.</strong>';
        steps = [
            'Abrí esta página en <strong>Google Chrome</strong>',
            'Tocá el ícono <strong>⋮</strong> (tres puntos) en la esquina superior derecha',
            'Seleccioná <strong>"Agregar a pantalla de inicio"</strong> o <strong>"Instalar app"</strong>',
            'Presioná <strong>"Agregar"</strong> o <strong>"Instalar"</strong>'
        ];
    } else if (platform === 'windows') {
        title = '💻 Instalar en Windows (PC)';
        note = '💡 Funciona en Chrome o Edge.';
        steps = [
            'Abrí esta página en <strong>Google Chrome</strong> o <strong>Microsoft Edge</strong>',
            'En Chrome: hacé clic en el ícono de instalación <strong>⊕</strong> en la barra de direcciones',
            'En Edge: hacé clic en el ícono <strong>⊕</strong> o el menú <strong>⋯</strong> → <strong>"Aplicaciones"</strong> → <strong>"Instalar este sitio como aplicación"</strong>',
            'Confirmá la instalación'
        ];
    } else if (platform === 'mac') {
        title = '💻 Instalar en Mac';
        note = '💡 Funciona en Chrome o Safari.';
        steps = [
            'Abrí esta página en <strong>Google Chrome</strong> o <strong>Safari</strong>',
            'En Chrome: hacé clic en el ícono <strong>⊕</strong> en la barra de direcciones',
            'En Safari: usá <strong>Archivo → Agregar a Dock</strong> (macOS Sonoma o superior)',
            'Confirmá la instalación'
        ];
    } else {
        title = '📱 Instalar App';
        note = '';
        steps = [
            'Abrí esta página en <strong>Chrome</strong> o <strong>Safari</strong>',
            'Buscá la opción <strong>"Agregar a pantalla de inicio"</strong> o <strong>"Instalar app"</strong> en el menú del navegador',
            'Confirmá la instalación'
        ];
    }
    
    modal.innerHTML = `
        <div class="ios-install-content">
            <h3>${title}</h3>
            ${note ? `<p style="color: #f7931e; margin-bottom: 12px;">${note}</p>` : ''}
            <ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol>
            <button onclick="this.closest('.ios-install-modal').remove()" class="btn btn-primary" style="margin-top:15px;">Entendido</button>
        </div>
    `;
    document.body.appendChild(modal);
}

// Verificar si la app ya está instalada (modo standalone)
function isAppInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches || 
           window.navigator.standalone === true;
}

// Ocultar botones si ya está instalada
if (isAppInstalled()) {
    const loginInstallBtn = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    const appInstallBtn = document.getElementById('appInstallBtn');
    if (loginInstallBtn) {
        loginInstallBtn.style.display = 'none';
        loginInstallBtn.classList.add('hidden');
    }
    if (headerInstallBtn) {
        headerInstallBtn.style.display = 'none';
        headerInstallBtn.classList.add('hidden');
    }
    // Ocultar botón APP usando clase .hidden (anula !important del CSS)
    if (appInstallBtn) {
        appInstallBtn.classList.add('hidden');
    }
}


// =============================================
// SISTEMA DE REFERIDOS
// =============================================

let referralData = null;

async function openReferralModal() {
    showModal('referralModal');
    await loadReferralData();
}

async function loadReferralData() {
    const histContainer = document.getElementById('referralPayoutHistory');
    if (histContainer) histContainer.innerHTML = '<span style="color:#888;font-size:12px;">Cargando...</span>';

    try {
        const [meRes, histRes] = await Promise.all([
            fetch(`${API_URL}/api/referrals/me`, {
                headers: { 'Authorization': `Bearer ${currentToken}` }
            }),
            fetch(`${API_URL}/api/referrals/history?limit=20`, {
                headers: { 'Authorization': `Bearer ${currentToken}` }
            })
        ]);

        if (!meRes.ok) {
            if (histContainer) histContainer.innerHTML = '<span style="color:#ff4444;font-size:12px;">No se pudieron cargar tus datos de referidos. Reintentá.</span>';
            return;
        }
        const meData = await meRes.json();
        const me = meData.data;

        // Actualizar UI
        document.getElementById('myReferralCode').textContent = me.referralCode || '—';
        document.getElementById('myReferralLink').textContent = me.referralLink || '—';
        // Referidos activos (nuevo campo) con fallback a totalReferred
        const activeCountEl = document.getElementById('referralActiveCount');
        if (activeCountEl) activeCountEl.textContent = me.activeReferred != null ? me.activeReferred : (me.totalReferred || 0);
        document.getElementById('referralHistoricalTotal').textContent =
            '$' + new Intl.NumberFormat('es-AR').format(Math.round(me.historicalTotalCredited || 0));
        document.getElementById('referralCurrentPeriod').textContent = me.currentPeriodLabel || me.currentPeriod || '—';

        referralData = me;

        // Summary para pendiente y último pago
        try {
            const sumRes = await fetch(`${API_URL}/api/referrals/summary`, {
                headers: { 'Authorization': `Bearer ${currentToken}` }
            });
            if (sumRes.ok) {
                const sumData = await sumRes.json();
                const sum = sumData.data;
                document.getElementById('referralPendingAmount').textContent =
                    '$' + new Intl.NumberFormat('es-AR').format(Math.round(sum.pendingEstimatedAmount || 0));
                document.getElementById('referralCreditDate').textContent =
                    sum.estimatedCreditDate || 'Inicio del próximo mes';
                // Último pago acreditado
                const lastPayoutEl = document.getElementById('referralLastPayoutAmount');
                if (lastPayoutEl) {
                    if (sum.lastPayout && sum.lastPayout.amount > 0) {
                        lastPayoutEl.textContent = '$' + new Intl.NumberFormat('es-AR').format(Math.round(sum.lastPayout.amount));
                        lastPayoutEl.title = sum.lastPayout.periodLabel || sum.lastPayout.periodKey || '';
                    } else {
                        lastPayoutEl.textContent = '—';
                    }
                }
            }
        } catch (e) { /* ignorar */ }

        const EMPTY_HISTORY_HTML = '<span style="color:#888;font-size:12px;">Todavía no tenés pagos por referidos.</span>';

        // Historial agrupado por período con badges de estado
        if (histRes.ok) {
            const histData = await histRes.json();
            const payouts = histData.data?.payouts || [];
            if (payouts.length === 0) {
                histContainer.innerHTML = EMPTY_HISTORY_HTML;
            } else {
                // Agrupar por período
                const byPeriod = new Map();
                for (const p of payouts) {
                    const key = p.periodKey || '?';
                    if (!byPeriod.has(key)) byPeriod.set(key, []);
                    byPeriod.get(key).push(p);
                }

                const statusBadgeHtml = (status) => {
                    if (status === 'paid')
                        return '<span style="background:rgba(0,255,136,0.12);border:1px solid rgba(0,255,136,0.4);color:#00ff88;font-size:10px;border-radius:4px;padding:2px 6px;">✅ Pagado</span>';
                    if (status === 'failed')
                        return '<span style="background:rgba(255,68,68,0.12);border:1px solid rgba(255,68,68,0.4);color:#ff4444;font-size:10px;border-radius:4px;padding:2px 6px;">❌ Fallido</span>';
                    if (status === 'cancelled')
                        return '<span style="background:rgba(136,136,136,0.12);border:1px solid rgba(136,136,136,0.4);color:#888;font-size:10px;border-radius:4px;padding:2px 6px;">🚫 Cancelado</span>';
                    return '<span style="background:rgba(247,147,30,0.12);border:1px solid rgba(247,147,30,0.4);color:#f7931e;font-size:10px;border-radius:4px;padding:2px 6px;">⏳ Pendiente</span>';
                };

                let html = '';
                for (const [pk, periodPayouts] of byPeriod) {
                    const label = periodPayouts[0].periodLabel || pk;
                    const paidTotal = periodPayouts
                        .filter(p => p.status === 'paid')
                        .reduce((s, p) => s + (p.totalCommissionAmount || 0), 0);
                    const hasMultiple = periodPayouts.length > 1;

                    html += `<div style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.05);">`;
                    html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">`;
                    html += `<span style="font-size:12px;color:#d4af37;font-weight:600;">📅 ${label}</span>`;
                    if (paidTotal > 0)
                        html += `<span style="font-size:12px;color:#00ff88;font-weight:bold;">$${new Intl.NumberFormat('es-AR').format(Math.round(paidTotal))}</span>`;
                    html += `</div>`;

                    for (const p of periodPayouts) {
                        // isDelta is the authoritative flag; payoutIndex fallback covers legacy records
                        // created before isDelta was added to the schema.
                        const isDelta = p.isDelta || (p.payoutIndex || 1) > 1;
                        const amount = p.totalCommissionAmount || 0;
                        html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;${hasMultiple ? 'padding-left:8px;' : ''}">`;
                        html += `<div style="display:flex;align-items:center;gap:6px;">`;
                        if (isDelta)
                            html += `<span style="background:rgba(212,175,55,0.12);border:1px solid rgba(212,175,55,0.35);color:#d4af37;font-size:10px;border-radius:4px;padding:1px 5px;">Δ delta</span>`;
                        html += `${statusBadgeHtml(p.status)}`;
                        html += `</div>`;
                        html += `<span style="font-size:13px;color:${p.status === 'paid' ? '#d4af37' : '#888'};font-weight:${p.status === 'paid' ? '600' : 'normal'};">$${new Intl.NumberFormat('es-AR').format(Math.round(amount))}</span>`;
                        html += `</div>`;
                    }
                    html += `</div>`;
                }
                histContainer.innerHTML = html;
            }
        } else {
            histContainer.innerHTML = EMPTY_HISTORY_HTML;
        }
    } catch (err) {
        console.error('[Referrals] Error cargando datos:', err);
        if (histContainer) histContainer.innerHTML = '<span style="color:#ff4444;font-size:12px;">No se pudieron cargar tus datos de referidos. Reintentá.</span>';
    }
}

function copyReferralCode() {
    const code = document.getElementById('myReferralCode').textContent;
    if (code && code !== '—') {
        navigator.clipboard.writeText(code).then(() => {
            showToast('✅ Código copiado', 'success');
        }).catch(() => {
            fallbackCopy(code);
        });
    }
}

function copyReferralLink() {
    const link = document.getElementById('myReferralLink').textContent;
    if (link && link !== '—') {
        navigator.clipboard.writeText(link).then(() => {
            showToast('✅ Link copiado', 'success');
        }).catch(() => {
            fallbackCopy(link);
        });
    }
}

function fallbackCopy(text) {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    try { document.execCommand('copy'); showToast('✅ Copiado', 'success'); } catch (e) {}
    document.body.removeChild(el);
}

// Exponer helpers para uso desde ui.js (cambio voluntario de contraseña desde PLATAFORMA).
// Este patrón global es consistente con window.toggleDrawer y otros helpers en este archivo.
window.setPasswordChangePending = function(value) { passwordChangePending = value; };
window.prepareChangePasswordModal = prepareChangePasswordModal;
