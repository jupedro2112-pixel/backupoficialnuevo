
/**
 * ADMIN PANEL - Sala de Juegos
 * Ultra-fast real-time chat with Socket.IO
 * Professional, clean, no lag
 */

// ============================================
// CONFIGURATION
// ============================================
const API_URL = '';
const SOCKET_OPTIONS = {
    // Allow both WebSocket and HTTP long-polling so the connection works even when
    // WebSocket is blocked (e.g. Cloudflare without WebSocket enabled) when
    // accessing via the custom domain vipcargas.com.  WebSocket is tried first
    // (faster), polling is used as fallback.
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
};

// ============================================
// STATE
// ============================================
let socket = null;
let currentToken = null;
let currentAdmin = null;
let selectedUserId = null;
let selectedUsername = null;
let selectedUserRole = null; // Role of the user currently selected for an action (password change, block…)
let selectedUserForBlock = null; // { id, username } for the block modal
let conversations = [];
let currentTab = 'open';
let typingTimeout = null;
let messageCache = new Map();
let lastSentMessageContent = null; // Para evitar duplicados de mensajes propios
let lastSentMessageTime = 0;
let availableCommands = []; // Comandos disponibles para sugerencias
let commandSuggestions = [];
let selectedCommandIndex = -1;
let processedMessageIds = new Set(); // CORREGIDO: Para evitar mensajes duplicados
let isLoadingMessages = false; // Para evitar cargas múltiples simultáneas
let activeConversationId = null; // Identificador estable del chat activo (race condition fix)
let activeFetchController = null; // AbortController para cancelar fetches de mensajes anteriores

// PWA - Instalación de App
let deferredInstallPrompt = null;
let isAppInstalled = false;

// Notificaciones Push
let pushSubscription = null;

// ============================================
// DOM ELEMENTS
// ============================================
const elements = {
    loginScreen: document.getElementById('loginScreen'),
    app: document.getElementById('app'),
    loginForm: document.getElementById('loginForm'),
    loginError: document.getElementById('loginError'),
    username: document.getElementById('username'),
    password: document.getElementById('password'),
    adminName: document.getElementById('adminName'),
    logoutBtn: document.getElementById('logoutBtn'),
    
    // Stats
    statUsers: document.getElementById('statUsers'),
    statOnline: document.getElementById('statOnline'),
    statMessages: document.getElementById('statMessages'),
    statUnread: document.getElementById('statUnread'),
    unreadBadge: document.getElementById('unreadBadge'),
    
    // Navigation
    navItems: document.querySelectorAll('.nav-item'),
    sections: document.querySelectorAll('.section'),
    
    // Chats
    conversationsList: document.getElementById('conversationsList'),
    searchUser: document.getElementById('searchUser'),
    refreshChats: document.getElementById('refreshChats'),
    tabBtns: document.querySelectorAll('.tab-btn'),
    
    // Chat panel
    chatHeader: document.getElementById('chatHeader'),
    chatMessages: document.getElementById('chatMessages'),
    chatInputArea: document.getElementById('chatInputArea'),
    chatUsername: document.getElementById('chatUsername'),
    chatStatus: document.getElementById('chatStatus'),
    chatAppStatus: document.getElementById('chatAppStatus'),
    chatBalance: document.getElementById('chatBalance'),
    chatBlockedBanner: document.getElementById('chatBlockedBanner'),
    chatBlockedReason: document.getElementById('chatBlockedReason'),
    messageInput: document.getElementById('messageInput'),
    sendMessage: document.getElementById('sendMessage'),
    typingIndicator: document.getElementById('typingIndicator'),

    // Action buttons
    btnCBU: document.getElementById('btnCBU'),
    btnDeposit: document.getElementById('btnDeposit'),
    btnBonus: document.getElementById('btnBonus'),
    btnWithdraw: document.getElementById('btnWithdraw'),
    btnPassword: document.getElementById('btnPassword'),
    btnPayments: document.getElementById('btnPayments'),
    btnBlock: document.getElementById('btnBlock'),
    btnUnblock: document.getElementById('btnUnblock'),
    btnClose: document.getElementById('btnClose'),
    
    // Modals
    depositModal: document.getElementById('depositModal'),
    withdrawModal: document.getElementById('withdrawModal'),
    passwordModal: document.getElementById('passwordModal'),
    
    // Toast
    toastContainer: document.getElementById('toastContainer')
};

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    checkAdminSession();
    setupEventListeners();
});

function setupEventListeners() {
    // Login
    elements.loginForm.addEventListener('submit', handleLogin);
    
    // Logout
    elements.logoutBtn.addEventListener('click', handleLogout);
    
    // Navigation
    elements.navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const section = item.dataset.section;
            switchSection(section);
        });
    });
    
    // Tabs - INSTANTÁNEO: mostrar inmediatamente sin delay
    elements.tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            elements.tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTab = btn.dataset.tab;
            // Limpiar selección de chat al cambiar de pestaña
            if (selectedUserId) {
                if (socket) socket.emit('leave_chat_room', { userId: selectedUserId });
                selectedUserId = null;
                elements.chatHeader.classList.add('hidden');
                elements.chatInputArea.classList.add('hidden');
                elements.chatMessages.innerHTML = `
                    <div class="empty-state">
                        <span class="icon icon-comment-dots"></span>
                        <p>Selecciona una conversación para ver los mensajes</p>
                    </div>
                `;
            }
            // Mostrar datos cacheados de la pestaña al instante (sin pantalla en blanco)
            const tabCache = conversationsCacheByTab.get(currentTab);
            if (tabCache && tabCache.data.length > 0) {
                conversations = tabCache.data;
                renderConversations();
            } else {
                elements.conversationsList.innerHTML = `
                    <div class="empty-state">
                        <span class="icon icon-sync" style="animation: spin 1s linear infinite;"></span>
                        <p>Cargando...</p>
                    </div>
                `;
            }
            // Refrescar datos en background (actualiza lista suavemente)
            loadConversations(false);
            // Actualizar botón según la pestaña
            updateActionButtonsByTab();
        });
    });
    
    // Search
    elements.searchUser.addEventListener('input', debounce((e) => {
        searchConversations(e.target.value);
    }, 300));
    
    // Refresh
    elements.refreshChats.addEventListener('click', loadConversations);
    
    // Chat input
    elements.messageInput.addEventListener('keydown', (e) => {
        // CORREGIDO: Manejar navegación y selección de comandos ANTES de enviar mensaje
        if (commandSuggestions.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectedCommandIndex = (selectedCommandIndex + 1) % commandSuggestions.length;
                updateCommandSelection();
                return;
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectedCommandIndex = (selectedCommandIndex - 1 + commandSuggestions.length) % commandSuggestions.length;
                updateCommandSelection();
                return;
            } else if (e.key === 'Enter' && selectedCommandIndex >= 0) {
                e.preventDefault();
                insertCommand(commandSuggestions[selectedCommandIndex].name);
                return;
            } else if (e.key === 'Tab') {
                e.preventDefault();
                const idx = selectedCommandIndex >= 0 ? selectedCommandIndex : 0;
                insertCommand(commandSuggestions[idx].name);
                return;
            } else if (e.key === 'Escape') {
                hideCommandSuggestions();
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
        handleTyping();
    });
    
    // COMANDOS: Detectar cuando se escribe "/" para mostrar sugerencias
    elements.messageInput.addEventListener('input', (e) => {
        const value = e.target.value;
        if (value.startsWith('/')) {
            showCommandSuggestions(value);
        } else {
            hideCommandSuggestions();
        }
        handleTyping();
    });
    
    elements.sendMessage.addEventListener('click', sendMessage);
    
    // CORREGIDO: Botón adjuntar imagen
    const attachImageBtn = document.getElementById('attachImageBtn');
    const imageInput = document.getElementById('imageInput');
    if (attachImageBtn && imageInput) {
        attachImageBtn.addEventListener('click', () => {
            imageInput.click();
        });
        imageInput.addEventListener('change', handleImageSelect);
    }

    // Pegar imagen con Ctrl+V desde portapapeles (escritorio)
    if (elements.messageInput) {
        elements.messageInput.addEventListener('paste', handleAdminPaste);
    }
    
    // Action buttons
    elements.btnCBU.addEventListener('click', sendCBU);
    elements.btnDeposit.addEventListener('click', () => {
        // Limpiar formulario antes de abrir
        document.getElementById('depositAmount').value = '';
        document.querySelectorAll('.quick-amounts button').forEach(b => b.classList.remove('active'));
        const bonusInfoEl = document.getElementById('bonusInfo');
        if (bonusInfoEl) bonusInfoEl.textContent = '';
        showModal('depositModal');
    });
    if (elements.btnBonus) {
        elements.btnBonus.addEventListener('click', () => {
            // Limpiar formulario de bonus antes de abrir
            const bonusAmountEl = document.getElementById('bonusAmount');
            const bonusDescEl = document.getElementById('bonusDesc');
            if (bonusAmountEl) bonusAmountEl.value = '';
            if (bonusDescEl) bonusDescEl.value = '';
            document.querySelectorAll('.bonus-options button').forEach(b => b.classList.remove('active'));
            showModal('bonusModal');
        });
    }
    elements.btnWithdraw.addEventListener('click', () => {
        // Limpiar formulario de retiro antes de abrir
        const withdrawAmountEl = document.getElementById('withdrawAmount');
        if (withdrawAmountEl) withdrawAmountEl.value = '';
        showModal('withdrawModal');
    });
    elements.btnPassword.addEventListener('click', () => {
        // Opening from the chat panel: clear any user-table-specific role override.
        selectedUserRole = null;
        showModal('passwordModal');
    });
    elements.btnPayments.addEventListener('click', sendToPayments);
    if (elements.btnBlock) elements.btnBlock.addEventListener('click', openBlockModalFromChat);
    if (elements.btnUnblock) elements.btnUnblock.addEventListener('click', handleUnblockFromChat);
    elements.btnClose.addEventListener('click', closeChat);
    
    // Modal close buttons
    document.querySelectorAll('.close-modal').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modal = e.target.closest('.modal');
            hideModal(modal.id);
        });
    });
    
    // Quick amounts - ACUMULATIVO
    document.querySelectorAll('.quick-amounts button').forEach(btn => {
        btn.addEventListener('click', () => {
            const amount = parseInt(btn.dataset.amount);
            const modal = btn.closest('.modal');
            if (modal.id === 'depositModal') {
                const currentAmount = parseInt(document.getElementById('depositAmount').value) || 0;
                document.getElementById('depositAmount').value = currentAmount + amount;
                calculateBonus();
            } else if (modal.id === 'withdrawModal') {
                const currentAmount = parseInt(document.getElementById('withdrawAmount').value) || 0;
                const newAmount = currentAmount + amount;
                document.getElementById('withdrawAmount').value = newAmount;
                updateWithdrawTotal();
            }
        });
    });
    
    // Bonus options
    document.querySelectorAll('.bonus-options button').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.bonus-options button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            calculateBonus();
        });
    });
    
    // Deposit amount change
    document.getElementById('depositAmount').addEventListener('input', calculateBonus);
    
    // Withdraw amount change - update total
    document.getElementById('withdrawAmount').addEventListener('input', updateWithdrawTotal);
    
    // Confirm buttons
    document.getElementById('confirmDeposit').addEventListener('click', handleDeposit);
    document.getElementById('confirmWithdraw').addEventListener('click', handleWithdraw);
    document.getElementById('confirmPasswordChange').addEventListener('click', handlePasswordChange);
    const confirmBonusBtn = document.getElementById('confirmBonus');
    if (confirmBonusBtn) {
        confirmBonusBtn.addEventListener('click', handleDirectBonus);
    }
    
    // Close modals on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                hideModal(modal.id);
            }
        });
    });
    
    // CORREGIDO: Tecla Escape para cerrar chat seleccionado (deseleccionar)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && selectedUserId) {
            // Si hay un modal abierto, cerrarlo primero
            const openModal = document.querySelector('.modal.active');
            if (openModal) {
                hideModal(openModal.id);
                return;
            }
            // Si no hay modal, deseleccionar el chat
            deselectChat();
        }
    });
}

// ============================================
// AUTHENTICATION
// ============================================
async function handleLogin(e) {
    e.preventDefault();
    
    const username = elements.username.value.trim();
    const password = elements.password.value;
    
    if (!username || !password) {
        showLoginError('Completa todos los campos');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (data.token) {
            currentToken = data.token;
            currentAdmin = data.user;
            
            // Configurar UI según el rol
            setupRoleBasedUI();
            
            // Verificar si necesita cambiar contraseña
            if (data.user.needsPasswordChange) {
                showPasswordChangeModal();
                return;
            }
            
            // Primero mostrar el panel
            showApp();
            
            // CORREGIDO: Solicitar permiso para notificaciones del navegador
            requestNotificationPermission();
            
            // Send FCM token to backend now that we have an auth token
            const pendingFcmToken = localStorage.getItem('adminFcmToken');
            if (pendingFcmToken) {
                fetch(`${API_URL}/api/notifications/register-token`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${currentToken}`
                    },
                    body: JSON.stringify({ fcmToken: pendingFcmToken })
                }).then(r => r.json()).then(d => {
                    if (d.success) console.log('[FCM Admin] ✅ Token registrado post-login');
                }).catch(() => {});
            }
            
            // Luego intentar cargar datos (con manejo de errores)
            try {
                initSocket();
            } catch (e) {
                console.log('Socket no disponible:', e);
            }
            
            try {
                loadConversations();
            } catch (e) {
                console.log('Error cargando conversaciones:', e);
            }
            
            try {
                loadStats();
            } catch (e) {
                console.log('Error cargando stats:', e);
            }

            startConversationReconciliation();
            
            showToast('Login exitoso', 'success');
        } else {
            showLoginError(data.message || data.error || 'Credenciales inválidas');
        }
    } catch (error) {
        console.error('Login error:', error);
        showLoginError('Error de conexión');
    }
}

async function checkAdminSession() {
    try {
        const response = await fetch(`${API_URL}/api/admin/me`, {
            credentials: 'include',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            currentToken = data.token || null;
            currentAdmin = data.user;
            setupRoleBasedUI();
            showApp();
            initSocket();
            // Solicitar permiso para notificaciones al iniciar
            requestNotificationPermission();
            loadConversations();
            loadStats();
            // Cargar comandos al iniciar para las sugerencias
            loadCommands();
            // Iniciar reconciliación periódica de conversaciones
            startConversationReconciliation();
        } else {
            showLogin();
        }
    } catch (error) {
        console.error('Session check error:', error);
        showLogin();
    }
}

function handleLogout() {
    if (socket) {
        socket.disconnect();
    }
    // Clear the server-side admin_session cookie (best-effort, ignore errors).
    fetch(`${API_URL}/api/auth/admin-logout`, { method: 'POST', credentials: 'include', headers: { 'Authorization': `Bearer ${currentToken}` } })
        .catch(() => {});
    currentToken = null;
    currentAdmin = null;
    selectedUserId = null;
    showLogin();
}

function showLogin() {
    elements.loginScreen.classList.remove('hidden');
    elements.app.classList.add('hidden');
    elements.username.value = '';
    elements.password.value = '';
    elements.loginError.textContent = '';
}

function showLoginError(message) {
    elements.loginError.textContent = message;
}

function showApp() {
    elements.loginScreen.classList.add('hidden');
    elements.app.classList.remove('hidden');
    elements.adminName.textContent = currentAdmin?.username || 'Admin';
}

function showPasswordChangeModal() {
    showModal('passwordModal');
    // Deshabilitar el botón de cerrar modal
    const closeBtn = document.querySelector('#passwordModal .close-modal');
    if (closeBtn) {
        closeBtn.style.display = 'none';
    }
    // Cambiar el botón de cancelar para que no funcione
    const cancelBtn = document.querySelector('#passwordModal .btn-secondary');
    if (cancelBtn) {
        cancelBtn.style.display = 'none';
    }
    // Agregar mensaje obligatorio
    const modalHeader = document.querySelector('#passwordModal .modal-header h3');
    if (modalHeader) {
        modalHeader.innerHTML = '<span class="icon icon-key"></span> Cambio de Contraseña Obligatorio';
    }
}

function setupRoleBasedUI() {
    const role = currentAdmin?.role;
    console.log('[Admin Panel] Rol detectado:', currentAdmin?.role);
    // Configurar pestañas visibles según el rol
    const tabOpen = document.querySelector('[data-tab="open"]');
    const tabClosed = document.querySelector('[data-tab="closed"]');
    const tabPayments = document.querySelector('[data-tab="payments"]');
    
    if (role === 'withdrawer') {
        // Withdrawer solo ve PAGOS
        if (tabOpen) tabOpen.style.display = 'none';
        if (tabClosed) tabClosed.style.display = 'none';
        if (tabPayments) tabPayments.style.display = 'flex';
        currentTab = 'payments';
    } else if (role === 'depositor') {
        // Depositer no ve PAGOS
        if (tabPayments) tabPayments.style.display = 'none';
        if (tabOpen) tabOpen.style.display = 'flex';
        if (tabClosed) tabClosed.style.display = 'flex';
        currentTab = 'open';
    } else {
        // Admin general ve todo
        if (tabOpen) tabOpen.style.display = 'flex';
        if (tabClosed) tabClosed.style.display = 'flex';
        if (tabPayments) tabPayments.style.display = 'flex';
    }
    
    // Depositor y withdrawer pueden ver "Usuarios" pero NO pueden exportar CSV
    const usersNavItem = document.querySelector('.nav-item[data-section="users"]');
    if (usersNavItem) {
        usersNavItem.style.display = ['admin', 'depositor', 'withdrawer'].includes(role) ? '' : 'none';
    }
    // Solo el admin general puede exportar usuarios
    const exportCsvBtn = document.getElementById('exportUsersCSVBtn');
    if (exportCsvBtn) {
        exportCsvBtn.style.display = role === 'admin' ? '' : 'none';
    }

    // Bonus directo: visible para admin y depositor
    const btnBonus = elements.btnBonus;
    if (btnBonus) {
        btnBonus.style.display = ['admin', 'depositor'].includes(role) ? '' : 'none';
    }

    // SMS Masivo: solo visible para admin general
    const smsNavItem = document.querySelector('.nav-item-sms-masivo');
    if (smsNavItem) {
        smsNavItem.style.display = role === 'admin' ? '' : 'none';
    }
    
    // Actualizar botones según la pestaña actual
    updateActionButtonsByTab();
}

// Actualizar botones de acción según la pestaña actual
function updateActionButtonsByTab() {
    const btnPayments = elements.btnPayments;
    if (!btnPayments) return;
    
    const role = currentAdmin?.role;
    
    if (currentTab === 'payments') {
        // En pestaña Pagos: mostrar "Enviar a Abiertos" solo para admin general (no para withdrawer)
        if (role === 'withdrawer') {
            btnPayments.style.display = 'none';
        } else {
            btnPayments.style.display = '';
            btnPayments.innerHTML = '<span class="icon icon-exchange"></span> Enviar a Abiertos';
            btnPayments.onclick = sendToOpen;
        }
    } else {
        btnPayments.style.display = '';
        // En otras pestañas: mostrar "Enviar a Pagos"
        btnPayments.innerHTML = '<span class="icon icon-exchange"></span> Enviar a Pagos';
        btnPayments.onclick = sendToPayments;
    }
}

// ============================================
// SOCKET.IO - ULTRA FAST
// ============================================
function initSocket() {
    if (socket) {
        socket.disconnect();
    }
    
    socket = io(SOCKET_OPTIONS);
    
    socket.on('connect', () => {
        console.log('✅ Socket connected');
        socket.emit('authenticate', currentToken);
    });
    
    socket.on('authenticated', (data) => {
        if (data.success) {
            console.log('✅ Socket authenticated');
            joinAdminRoom();
        } else {
            console.error('❌ Socket authentication failed');
        }
    });
    
    // NEW MESSAGE - INSTANT
    socket.on('new_message', (data) => {
        console.log('📨 NEW_MESSAGE event received:', data);
        console.log('📨 Message content:', data.message?.content || data.content);
        console.log('📨 Sender role:', data.message?.senderRole || data.senderRole);
        console.log('📨 Sender ID:', data.message?.senderId || data.senderId);
        handleNewMessage(data);
    });
    
    // MESSAGE SENT CONFIRMATION
    socket.on('message_sent', (data) => {
        console.log('✅ Message sent:', data);
        // Update temp message with real one instead of adding duplicate
        const tempEl = document.querySelector('[data-messageid^="temp-"]');
        if (tempEl) {
            tempEl.dataset.messageid = data.id;
        }
    });
    
    // CHAT CLOSED - Mantener chat abierto para seguir respondiendo
    socket.on('chat_closed', (data) => {
        console.log('🔒 Chat cerrado:', data);
        if (data.userId === selectedUserId) {
            showToast('Chat movido a Cerrados. Puedes seguir respondiendo.', 'info');
            // Fix #3: Recargar mensajes para mostrar el mensaje de cierre desde DB
            messageCache.delete(selectedUserId);
            loadMessages(selectedUserId);
        }
        // Invalidar cache de las pestañas afectadas y recargar
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('closed');
        loadConversations(true);
    });
    
    // CONVERSATION_UPDATED (para compatibilidad con versiones anteriores del backend)
    socket.on('conversation_updated', (data) => {
        console.log('🔄 Conversation updated:', data);
        if (data.userId !== selectedUserId) {
            incrementUnreadCount();
            playNotificationSound();
        }
        conversationsCacheByTab.delete(currentTab);
        loadConversations(true);
    });
    
    // CHAT MOVED TO PAYMENTS
    socket.on('chat_moved', (data) => {
        console.log('💳 Chat moved to payments:', data);
        if (data.userId === selectedUserId) {
            selectedUserId = null;
            activeConversationId = null; // RACE CONDITION FIX
            elements.chatHeader.classList.add('hidden');
            elements.chatInputArea.classList.add('hidden');
            elements.chatMessages.innerHTML = `
                <div class="empty-state">
                    <span class="icon icon-comment-dots"></span>
                    <p>Chat enviado a pagos. Selecciona otra conversación.</p>
                </div>
            `;
        }
        // Invalidar cache de pestañas afectadas
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('payments');
        loadConversations(true);
        showToast('Chat enviado a pagos', 'info');
    });
    
    // USER TYPING
    socket.on('user_typing', (data) => {
        if (data.userId === selectedUserId) {
            showTypingIndicator();
        }
    });
    
    socket.on('user_stop_typing', (data) => {
        if (data.userId === selectedUserId) {
            hideTypingIndicator();
        }
    });
    
    // STATS UPDATE
    socket.on('stats', (data) => {
        updateStats(data);
    });
    
    // USER ONLINE/OFFLINE
    socket.on('user_connected', (data) => {
        updateUserStatus(data.userId, true);
        // Si el usuario conectado es el chat activo, actualizar info (incl. estado de app)
        if (data.userId === selectedUserId) {
            loadUserInfo(data.userId);
        }
    });
    
    socket.on('user_disconnected', (data) => {
        updateUserStatus(data.userId, false);
    });
    
    // Actualizar estado de app de notificaciones en tiempo real
    socket.on('user_app_status', (data) => {
        if (data.userId === selectedUserId && elements.chatAppStatus) {
            if (data.appInstalled && data.fcmTokenContext === 'standalone') {
                elements.chatAppStatus.textContent = '📱 APP INSTALADA';
                elements.chatAppStatus.style.color = '#00ff88';
            } else if (data.appInstalled && data.fcmTokenContext !== 'standalone') {
                elements.chatAppStatus.textContent = '🌐 NOTIS EN NAVEGADOR';
                elements.chatAppStatus.style.color = '#4fc3f7';
            } else {
                elements.chatAppStatus.textContent = '📵 NOTIS INACTIVAS';
                elements.chatAppStatus.style.color = '#aaa';
            }
        }
    });
    
    // CHAT UPDATED - Actualizar lista lateral en tiempo real cuando llega un mensaje
    socket.on('chat_updated', (data) => {
        const convIndex = conversations.findIndex(c => c.userId === data.userId);
        if (convIndex === -1) {
            // Conversación nueva o no visible: invalidar cache y recargar
            conversationsCacheByTab.delete(currentTab);
            loadConversations(true);
            return;
        }
        const conv = conversations[convIndex];
        conv.lastMessageAt = data.lastMessageAt || new Date();
        if (data.unreadIncrement > 0 && data.userId !== selectedUserId) {
            conv.unread = (conv.unread || 0) + data.unreadIncrement;
        }
        // Mover al tope de la lista
        conversations.splice(convIndex, 1);
        conversations.unshift(conv);
        // Actualizar cache
        conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
        renderConversations();
    });

    // MESSAGES READ - Sincronizar estado leído/no leído entre admins
    socket.on('messages_read', (data) => {
        const convIndex = conversations.findIndex(c => c.userId === data.userId);
        if (convIndex !== -1) {
            conversations[convIndex].unread = 0;
            conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
            renderConversations();
        }
        loadStats();
    });

    // ADMIN MESSAGE SENT - Actualizar lista cuando otro admin envía un mensaje
    socket.on('admin_message_sent', (data) => {
        const message = data.message;
        if (!message) return;
        const chatUserId = data.receiverId;
        const currentAdminId = currentAdmin && (currentAdmin.userId || currentAdmin.id);
        // Si otro admin envió al chat activo, mostrar el mensaje
        if (chatUserId === selectedUserId && data.senderId !== currentAdminId) {
            if (!processedMessageIds.has(message.id)) {
                processedMessageIds.add(message.id);
                addMessageToChat(message, true);
                scrollToBottom();
            }
        }
        // Actualizar conversación en la lista
        updateConversationInList(message);
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        console.log('🔌 Socket disconnected');
    });

    // RECONNECT - Re-fetch conversations to recover any missed events
    socket.on('reconnect', () => {
        console.log('🔄 Socket reconnected — re-fetching conversations');
        conversationsCacheByTab.delete(currentTab);
        loadConversations(true);
    });
    
    // ERROR
    socket.on('error', (data) => {
        console.error('❌ Socket error:', data);
        showToast(data.message || 'Error de conexión', 'error');
    });
}

// Reconciliación periódica: cada 60 segundos invalidar cache y recargar
// conversaciones para recuperar cualquier evento perdido por reconexión u otro motivo.
let reconciliationInterval = null;
function startConversationReconciliation() {
    if (reconciliationInterval) clearInterval(reconciliationInterval);
    reconciliationInterval = setInterval(() => {
        conversationsCacheByTab.delete(currentTab);
        loadConversations(false);
    }, 60000);
}

function joinAdminRoom() {
    socket.emit('join_admin_room');
}

function handleNewMessage(data) {
    const message = data.message || data;
    const senderId = message.senderId;
    const receiverId = message.receiverId;
    
    console.log('📨 handleNewMessage:', message.id, 'from:', senderId, 'to:', receiverId, 'selected:', selectedUserId);
    
    // CORREGIDO: Verificar si el mensaje ya fue procesado (evitar duplicados del socket)
    if (message.id) {
        if (processedMessageIds.has(message.id)) {
            console.log('⚠️ Mensaje ya procesado (ID en cache), ignorando:', message.id);
            return;
        }
        processedMessageIds.add(message.id);
    }
    
    // Verificar si el mensaje ya existe en el DOM
    if (message.id && elements.chatMessages.querySelector(`[data-messageid="${message.id}"]`)) {
        console.log('⚠️ Mensaje ya existe en DOM, ignorando');
        return;
    }
    
    // CORREGIDO: Verificar mensajes temporales con mismo contenido (evitar duplicados del optimistic UI)
    if (message.content) {
        const tempElements = elements.chatMessages.querySelectorAll('[data-messageid^="temp-"]');
        for (const tempEl of tempElements) {
            const tempContent = tempEl.querySelector('.message-content')?.textContent?.trim();
            if (tempContent === message.content.trim()) {
                // Actualizar el ID temporal al real en lugar de crear duplicado
                tempEl.dataset.messageid = message.id;
                console.log('✅ Mensaje temporal actualizado con ID real:', message.id);
                return;
            }
        }
    }
    
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    const isFromAdmin = adminRoles.includes(message.senderRole);
    const isSystemMessage = message.type === 'system' || senderId === 'admin' || senderId === 'system';
    
    // Determinar el userId del chat al que pertenece este mensaje
    const chatUserId = isFromAdmin || isSystemMessage ? receiverId : senderId;
    
    // Si hay un chat seleccionado y este mensaje pertenece a ese chat, mostrarlo
    if (selectedUserId && chatUserId === selectedUserId) {
        addMessageToChat(message, isFromAdmin || isSystemMessage);
        markMessagesAsRead(selectedUserId);
        playNotificationSound();
        scrollToBottom();
        setTimeout(scrollToBottom, 100);
        // También actualizar conversación en la lista (mover al tope y actualizar preview)
        updateConversationInList(message);
    } else {
        // Mensaje de otro chat - actualizar lista y mostrar notificación
        incrementUnreadCount();
        playNotificationSound();
        // Mostrar notificación del navegador
        const senderName = message.senderUsername || 'Usuario';
        const messagePreview = message.type === 'image' ? '📸 Imagen' : message.type === 'video' ? '🎥 Video' : (message.content?.substring(0, 50) + '...');
        showBrowserNotification(
            `💬 Nuevo mensaje de ${senderName}`,
            messagePreview,
            '/favicon.ico'
        );
        // Actualizar conversación en la lista en tiempo real (sin HTTP call)
        updateConversationInList(message);
    }
}

// ============================================
// CONVERSATIONS
// ============================================
// Cache por pestaña: clave = tab ('open'|'closed'|'payments'), valor = { data: [], timestamp: 0 }
let conversationsCacheByTab = new Map();
const CONVERSATIONS_CACHE_TIME = 30000; // 30 segundos (actualizamos en tiempo real vía WebSocket)

/**
 * Actualización inteligente de una conversación en la lista (sin HTTP call).
 * Se llama cuando llega un mensaje nuevo de otro chat.
 */
function updateConversationInList(message) {
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    const isFromAdmin = adminRoles.includes(message.senderRole);
    const chatUserId = isFromAdmin ? message.receiverId : message.senderId;
    
    // Actualizar en el array conversations actual
    const convIndex = conversations.findIndex(c => c.userId === chatUserId);
    if (convIndex === -1) {
        // Conversación nueva o no visible: invalidar cache y recargar
        conversationsCacheByTab.delete(currentTab);
        loadConversations(true);
        return;
    }
    
    const conv = conversations[convIndex];
    if (message.type === 'video') {
        conv.lastMessage = '🎥 Video';
    } else if (message.type !== 'image') {
        conv.lastMessage = message.content;
    } else {
        conv.lastMessage = '📸 Imagen';
    }
    conv.lastMessageAt = message.timestamp || new Date();
    if (!isFromAdmin) {
        conv.unread = (conv.unread || 0) + 1;
    }
    
    // Mover la conversación al top de la lista
    conversations.splice(convIndex, 1);
    conversations.unshift(conv);
    
    // Actualizar cache de la pestaña actual
    conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
    
    // Re-renderizar la lista de forma instantánea
    renderConversations();
}

// Cargar conversaciones con cache por pestaña
async function loadConversations(forceRefresh = false) {
    const now = Date.now();
    const tabCache = conversationsCacheByTab.get(currentTab);
    
    // Usar cache si está disponible, no es forzado y no expiró
    if (!forceRefresh && tabCache && (now - tabCache.timestamp) < CONVERSATIONS_CACHE_TIME) {
        conversations = tabCache.data;
        renderConversations();
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/conversations?status=${currentTab}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            console.error('[loadConversations] HTTP', response.status, errBody);
            showToast(`Error cargando ${currentTab}: ${errBody.error || response.status}`, 'error');
            // NO guardar respuesta vacía en cache cuando hay error
            return;
        }
        
        const data = await response.json();
        conversations = data.conversations || [];
        
        // Guardar en cache por pestaña
        conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
        
        renderConversations();
        
        // PREFETCH: Cargar mensajes de los primeros 3 chats en background
        prefetchMessages(conversations.slice(0, 3));
    } catch (error) {
        console.error('Error loading conversations:', error);
    }
}

// PREFETCH: Cargar mensajes silenciosamente
async function prefetchMessages(convs) {
    for (const conv of convs) {
        if (!messageCache.has(conv.userId)) {
            fetch(`${API_URL}/api/messages/${conv.userId}?limit=50`, {
                headers: { 'Authorization': `Bearer ${currentToken}` }
            })
            .then(r => r.json())
            .then(data => {
                if (data.messages) {
                    messageCache.set(conv.userId, data.messages);
                }
            })
            .catch(() => {});
        }
    }
}

function renderConversations() {
    if (conversations.length === 0) {
        elements.conversationsList.innerHTML = `
            <div class="empty-state">
                <span class="icon icon-comments"></span>
                <p>No hay conversaciones</p>
            </div>
        `;
        return;
    }
    
    elements.conversationsList.innerHTML = conversations.map(conv => `
        <div class="conversation-item ${conv.unread > 0 ? 'unread' : ''} ${conv.userId === selectedUserId ? 'active' : ''}" 
             data-userid="${escapeHtml(conv.userId)}" 
             data-username="${escapeHtml(conv.username)}">
            <div class="conv-avatar">
                <span class="icon icon-user"></span>
            </div>
            <div class="conv-info">
                <span class="conv-name">${escapeHtml(conv.username)}</span>
                <span class="conv-preview">${escapeHtml(conv.lastMessage || 'Sin mensajes')}</span>
            </div>
            <div class="conv-meta">
                <span class="conv-time">${formatTime(conv.lastMessageAt)}</span>
                ${conv.unread > 0 ? `<span class="conv-badge">${conv.unread}</span>` : ''}
            </div>
        </div>
    `).join('');
    
    // Add click handlers
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.addEventListener('click', () => {
            const userId = item.dataset.userid;
            const username = item.dataset.username;
            selectConversation(userId, username);
        });
    });
}

function searchConversations(query) {
    const items = document.querySelectorAll('.conversation-item');
    const lowerQuery = query.toLowerCase();
    
    items.forEach(item => {
        const name = item.querySelector('.conv-name').textContent.toLowerCase();
        item.style.display = name.includes(lowerQuery) ? 'flex' : 'none';
    });
}

// CORREGIDO: Optimizado para eliminar lag al seleccionar conversación
async function selectConversation(userId, username) {
    // CORREGIDO: Salir de la sala anterior si existe
    if (selectedUserId && socket) {
        socket.emit('leave_chat_room', { userId: selectedUserId });
    }
    
    selectedUserId = userId;
    selectedUsername = username;
    activeConversationId = userId; // Identificador estable para verificar respuestas tardías
    
    // Update UI inmediatamente
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.classList.toggle('active', item.dataset.userid === userId);
    });
    
    // Fix #2: Marcar como leído de forma instantánea en la UI (antes de la llamada API)
    const convItem = document.querySelector(`.conversation-item[data-userid="${userId}"]`);
    if (convItem) {
        convItem.classList.remove('unread');
        const badge = convItem.querySelector('.conv-badge');
        if (badge) badge.remove();
    }
    const conv = conversations.find(c => c.userId === userId);
    if (conv && conv.unread > 0) {
        const currentBadgeCount = parseInt(elements.unreadBadge.textContent) || 0;
        const newCount = Math.max(0, currentBadgeCount - conv.unread);
        if (newCount <= 0) {
            elements.unreadBadge.classList.add('hidden');
            elements.unreadBadge.textContent = '0';
        } else {
            elements.unreadBadge.textContent = String(newCount);
        }
        conv.unread = 0;
    }
    
    // Show chat panel inmediatamente
    elements.chatHeader.classList.remove('hidden');
    elements.chatInputArea.classList.remove('hidden');
    elements.chatUsername.textContent = username;

    // Reset banner de bloqueo y botones hasta que loadUserInfo confirme el estado
    if (elements.chatBlockedBanner) elements.chatBlockedBanner.style.display = 'none';
    if (elements.chatBlockedReason) elements.chatBlockedReason.textContent = '';
    if (elements.btnBlock) elements.btnBlock.style.display = 'none';
    if (elements.btnUnblock) elements.btnUnblock.style.display = 'none';
    
    // CORREGIDO: Mostrar mensajes cacheados inmediatamente (sin esperar)
    const cachedMessages = messageCache.get(userId);
    if (cachedMessages && cachedMessages.length > 0) {
        renderMessages(cachedMessages);
    } else {
        // Mostrar loading mientras se cargan los mensajes
        elements.chatMessages.innerHTML = `
            <div class="empty-state">
                <span class="icon icon-sync" style="animation: spin 1s linear infinite;"></span>
                <p>Cargando mensajes...</p>
            </div>
        `;
    }
    
    // CORREGIDO: Unirse a la sala de chat del usuario
    if (socket) {
        socket.emit('join_chat_room', { userId });
    }
    
    // CORREGIDO: Cargar mensajes en paralelo (no await) para eliminar lag
    loadMessages(userId).then(() => {
        // Mark as read después de cargar (confirma en DB)
        // RACE CONDITION FIX: Solo marcar leído si este chat sigue activo
        if (userId === activeConversationId) {
            markMessagesAsRead(userId);
        }
    });
    
    // Load user info en paralelo
    loadUserInfo(userId);
}

// Solicitar permiso para notificaciones del navegador
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

async function loadMessages(userId) {
    // RACE CONDITION FIX: Crear un nuevo AbortController para este fetch
    if (activeFetchController) {
        activeFetchController.abort();
    }
    const controller = new AbortController();
    activeFetchController = controller;

    isLoadingMessages = true;
    
    try {
        // Mostrar mensajes cacheados inmediatamente si existen
        const cachedMessages = messageCache.get(userId);
        if (cachedMessages && cachedMessages.length > 0) {
            // Verificar que siga siendo el chat activo antes de renderizar cache
            if (userId === activeConversationId) {
                renderMessages(cachedMessages);
            }
        } else {
            // Solo mostrar loading si no hay cache y sigue activo
            if (userId === activeConversationId) {
                elements.chatMessages.innerHTML = '<div class="empty-state"><span class="icon icon-sync" style="animation: spin 1s linear infinite;"></span><p>Cargando mensajes...</p></div>';
            }
        }
        
        // Cargar últimos 50 mensajes previos (límite del panel de admin)
        const response = await fetch(`${API_URL}/api/messages/${userId}?limit=50`, {
            signal: controller.signal,
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load messages');
        
        const data = await response.json();
        const messages = data.messages || [];
        
        // RACE CONDITION FIX: Ignorar respuesta si ya no es el chat activo
        if (userId !== activeConversationId) {
            console.log('⚠️ Respuesta de chat antiguo ignorada:', userId, '!= activo:', activeConversationId);
            return;
        }
        
        // Cache messages
        messageCache.set(userId, messages);
        
        // Solo re-renderizar si hay cambios
        renderMessages(messages);
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('🚫 Fetch de mensajes cancelado para:', userId);
            return;
        }
        console.error('Error loading messages:', error);
        // Solo mostrar error si sigue siendo el chat activo y no hay cache
        if (userId === activeConversationId && !messageCache.get(userId)) {
            elements.chatMessages.innerHTML = '<div class="empty-state"><span class="icon icon-times-circle"></span><p>Error cargando mensajes</p></div>';
        }
    } finally {
        // Limpiar controller solo si sigue siendo el activo
        if (activeFetchController === controller) {
            activeFetchController = null;
        }
        isLoadingMessages = false;
    }
}

function renderMessages(messages) {
    // Si no hay mensajes en absoluto, mostrar empty state
    if (messages.length === 0) {
        elements.chatMessages.innerHTML = `
            <div class="empty-state">
                <span class="icon icon-comment-dots"></span>
                <p>No hay mensajes aún</p>
            </div>
        `;
        return;
    }
    
    // Usar DocumentFragment para mínimo reflow DOM
    const fragment = document.createDocumentFragment();
    processedMessageIds.clear();

    function getAdminDateLabel(dateStr) {
        const d = new Date(dateStr);
        const today = new Date();
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const opts = { timeZone: 'America/Argentina/Buenos_Aires' };
        const dStr = d.toLocaleDateString('es-AR', opts);
        const todayStr = today.toLocaleDateString('es-AR', opts);
        const yesterdayStr = yesterday.toLocaleDateString('es-AR', opts);
        if (dStr === todayStr) return 'Hoy';
        if (dStr === yesterdayStr) return 'Ayer';
        return d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Argentina/Buenos_Aires' });
    }

    let lastDateLabel = '';
    messages.forEach(msg => {
        if (msg.id) {
            processedMessageIds.add(msg.id);
        }
        const dateLabel = getAdminDateLabel(msg.timestamp || new Date());
        if (dateLabel !== lastDateLabel) {
            const sep = document.createElement('div');
            sep.className = 'chat-date-separator';
            sep.innerHTML = `<span>${dateLabel}</span>`;
            fragment.appendChild(sep);
            lastDateLabel = dateLabel;
        }
        const msgDiv = createMessageElement(msg);
        fragment.appendChild(msgDiv);
    });
    
    elements.chatMessages.innerHTML = '';
    elements.chatMessages.appendChild(fragment);
    
    // Scroll instantáneo al final
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function formatMessageContent(msg) {
    if (msg.type === 'image') {
        const safeUrl = encodeURI(msg.content);
        return `<img src="${safeUrl}" class="message-image" data-lightbox-src="${safeUrl}" alt="Imagen" loading="lazy" style="cursor:pointer;">`;
    }
    
    if (msg.type === 'video') {
        const safeUrl = encodeURI(msg.content);
        return `<video src="${safeUrl}" class="message-video" controls preload="metadata" style="max-width:100%;max-height:300px;border-radius:8px;"></video>`;
    }
    
    // CORREGIDO: Convertir URLs en links clickeables
    let content = escapeHtml(msg.content);
    
    // Detectar y convertir URLs en links
    const urlRegex = /(https?:\/\/[^\s<]+[^\s<.,;:!?])/g;
    content = content.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" class="chat-link">$1</a>');
    
    // Preservar saltos de línea
    content = content.replace(/\n/g, '<br>');
    
    return content;
}

function openLightbox(imageSrc) {
    const lightbox = document.getElementById('imageLightbox');
    const img = document.getElementById('lightboxImage');
    img.src = imageSrc;
    lightbox.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeLightbox(event) {
    // Close if clicked on background or close button
    if (event.target.id === 'imageLightbox' || event.target.classList.contains('lightbox-close')) {
        const lightbox = document.getElementById('imageLightbox');
        lightbox.classList.add('hidden');
        document.body.style.overflow = '';
    }
}

function addMessageToChat(message, isOutgoing = false) {
    // CORREGIDO: Verificar si el mensaje ya existe en el DOM (evitar duplicados)
    if (message.id) {
        const existingById = elements.chatMessages.querySelector(`[data-messageid="${message.id}"]`);
        if (existingById) {
            console.log('⚠️ Mensaje ya existe por ID, ignorando:', message.id);
            return;
        }
        // Verificar si existe un mensaje temporal con el mismo contenido
        const tempElements = elements.chatMessages.querySelectorAll('[data-messageid^="temp-"]');
        for (const tempEl of tempElements) {
            const tempContent = tempEl.querySelector('.message-content')?.textContent?.trim();
            const tempTime = tempEl.querySelector('.message-time')?.textContent;
            if (tempContent === message.content && tempTime) {
                // Actualizar el ID temporal al real
                tempEl.dataset.messageid = message.id;
                console.log('✅ Mensaje temporal actualizado con ID real:', message.id);
                // CORREGIDO: Scroll después de actualizar
                scrollToBottom();
                setTimeout(scrollToBottom, 100);
                return;
            }
        }
    }
    
    // CORREGIDO: Agregar a mensajes procesados
    if (message.id) {
        processedMessageIds.add(message.id);
        // Limpiar Set si crece demasiado
        if (processedMessageIds.size > 100) {
            const iterator = processedMessageIds.values();
            processedMessageIds.delete(iterator.next().value);
        }
    }
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}`;
    msgDiv.dataset.messageid = message.id;
    msgDiv.innerHTML = `
        <div class="message-header">
            <span class="icon icon-user"></span>
            <span>${escapeHtml(message.senderUsername)}</span>
        </div>
        <div class="message-content">${formatMessageContent(message)}</div>
        <div class="message-time">${formatDateTime(message.timestamp || new Date())}</div>
    `;
    
    // Remove empty state if exists
    const emptyState = elements.chatMessages.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }
    
    elements.chatMessages.appendChild(msgDiv);
    
    // CORREGIDO: Scroll automático con múltiples intentos
    requestAnimationFrame(() => {
        scrollToBottom();
        setTimeout(scrollToBottom, 50);
        setTimeout(scrollToBottom, 150);
        setTimeout(scrollToBottom, 300);
    });
}

function getMessageType(msg) {
    if (msg.type === 'system') return 'system';
    // CORREGIDO: Incluir depositor y withdrawer como roles de admin
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    if (adminRoles.includes(msg.senderRole)) return 'outgoing';
    return 'incoming';
}

// ============================================
// MESSAGING
// ============================================
async function sendMessage() {
    const content = elements.messageInput.value.trim();
    if (!content || !selectedUserId) return;

    // Issue #3: Si el admin escribe un comando (/...), enviar solo la respuesta del comando
    let messageToSend = content;
    if (content.startsWith('/')) {
        const cmdName = content.split(' ')[0];
        const cmd = availableCommands.find(c => c.name === cmdName);
        if (cmd && cmd.response) {
            messageToSend = cmd.response;
        } else if (cmd) {
            showToast('Este comando no tiene respuesta configurada', 'error');
            elements.messageInput.value = '';
            elements.messageInput.style.height = 'auto';
            hideCommandSuggestions();
            return;
        } else {
            showToast('Comando no encontrado', 'error');
            elements.messageInput.value = '';
            elements.messageInput.style.height = 'auto';
            hideCommandSuggestions();
            return;
        }
        hideCommandSuggestions();
    }
    
    // CORREGIDO: Verificar si ya existe un mensaje con el mismo contenido en los últimos 3 segundos
    const recentMessages = elements.chatMessages.querySelectorAll('.message');
    const now = Date.now();
    for (const msg of recentMessages) {
        const msgContent = msg.querySelector('.message-content')?.textContent?.trim();
        const msgTime = msg.querySelector('.message-time')?.textContent;
        if (msgContent === messageToSend && msgTime) {
            // Verificar si el mensaje fue enviado hace menos de 3 segundos
            const msgTimestamp = new Date(msgTime).getTime();
            if (now - msgTimestamp < 3000) {
                console.log('⚠️ Mensaje duplicado detectado (enviado hace menos de 3s), ignorando');
                elements.messageInput.value = '';
                elements.messageInput.style.height = 'auto';
                return;
            }
        }
    }
    
    // CORREGIDO: Verificar si ya se envió este contenido recientemente
    if (lastSentMessageContent === messageToSend && (now - lastSentMessageTime) < 5000) {
        console.log('⚠️ Mensaje duplicado detectado (mismo contenido reciente), ignorando');
        elements.messageInput.value = '';
        elements.messageInput.style.height = 'auto';
        return;
    }
    
    // Clear input immediately for better UX
    elements.messageInput.value = '';
    elements.messageInput.style.height = 'auto';
    
    // CORREGIDO: Guardar el contenido del mensaje enviado para evitar duplicados
    lastSentMessageContent = messageToSend;
    lastSentMessageTime = Date.now();
    
    // Optimistic UI - show message immediately
    const tempMessage = {
        id: 'temp-' + now,
        senderId: currentAdmin.userId,
        senderUsername: currentAdmin.username,
        senderRole: 'admin',
        content: messageToSend,
        timestamp: new Date(),
        type: 'text'
    };
    
    addMessageToChat(tempMessage, true);
    
    // CORREGIDO: Actualizar lista de conversaciones en tiempo real (optimistic)
    updateConversationInList({ ...tempMessage, receiverId: selectedUserId, senderId: currentAdmin.userId || currentAdmin.id, senderRole: 'admin' });
    scrollToBottom();
    setTimeout(scrollToBottom, 100);
    setTimeout(scrollToBottom, 300);
    
    // Send via socket (fastest)
    if (socket && socket.connected) {
        socket.emit('send_message', {
            content: messageToSend,
            receiverId: selectedUserId,
            type: 'text'
        });
        
        // CORREGIDO: Enviar notificación push al usuario
        sendPushNotification(selectedUserId, {
            type: 'text',
            content: messageToSend
        });
    } else {
        // Fallback to REST API
        try {
            const response = await fetch(`${API_URL}/api/messages/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentToken}`
                },
                body: JSON.stringify({
                    content: messageToSend,
                    receiverId: selectedUserId,
                    type: 'text'
                })
            });
            
            if (!response.ok) throw new Error('Failed to send message');
            
            const data = await response.json();
            
            // Update temp message with real one
            const tempEl = document.querySelector(`[data-messageid="${tempMessage.id}"]`);
            if (tempEl) {
                tempEl.dataset.messageid = data.id;
            }
            
            // CORREGIDO: Scroll después de confirmar
            scrollToBottom();
            
            // CORREGIDO: Enviar notificación push al usuario
            sendPushNotification(selectedUserId, {
                type: 'text',
                content: messageToSend
            });
            
        } catch (error) {
            console.error('Error sending message:', error);
            showToast('Error al enviar mensaje', 'error');
        }
    }
    
    // Stop typing
    socket.emit('stop_typing', { receiverId: selectedUserId });
}

// CORREGIDO: Convertir archivo a base64
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
        reader.readAsDataURL(file);
    });
}

// Comprime una imagen via Canvas: max 1600px lado mayor, JPEG q0.85.
// Necesario porque el endpoint rechaza base64 > 5MB.
function compressImageFile(file, { maxDim = 1600, quality = 0.85 } = {}) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            let { width, height } = img;
            if (width > maxDim || height > maxDim) {
                if (width >= height) {
                    height = Math.round(height * (maxDim / width));
                    width = maxDim;
                } else {
                    width = Math.round(width * (maxDim / height));
                    height = maxDim;
                }
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            try {
                resolve(canvas.toDataURL('image/jpeg', quality));
            } catch (err) {
                reject(err);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('No se pudo decodificar la imagen'));
        };
        img.src = url;
    });
}

function removeTempMessageEl(tempId) {
    // admin's addMessageToChat stores the message id in data-messageid (one word)
    const el = document.querySelector(`[data-messageid="${tempId}"]`);
    if (el) el.remove();
}

async function parseFetchError(response, fallback) {
    try {
        const body = await response.json();
        if (body && body.error) return body.error;
    } catch (_) {}
    return fallback || `Error ${response.status}`;
}

// Manejar selección de imagen o video
async function handleImageSelect(e) {
    const file = e.target.files[0];
    if (!file || !selectedUserId) return;

    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) {
        showToast('❌ Solo se permiten imágenes o videos', 'error');
        e.target.value = '';
        return;
    }
    if (isImage && file.size > 30 * 1024 * 1024) {
        showToast('❌ La imagen es muy grande (máx 30 MB)', 'error');
        e.target.value = '';
        return;
    }
    // Videos no se comprimen en el navegador: el server rechaza base64 > 5MB
    if (isVideo && file.size > 3.5 * 1024 * 1024) {
        showToast('❌ El video es muy grande (máx 3.5 MB)', 'error');
        e.target.value = '';
        return;
    }

    const sendingIndicator = document.getElementById('sendingIndicator');
    if (sendingIndicator) sendingIndicator.classList.remove('hidden');

    const fileType = isVideo ? 'video' : 'image';
    const fileLabel = isVideo ? '🎥 Video' : '📸 Imagen';
    const tempId = 'temp-' + fileType + '-' + Date.now();

    try {
        const dataUrl = isImage
            ? await compressImageFile(file)
            : await fileToBase64(file);

        const tempMessage = {
            id: tempId,
            senderId: currentAdmin.userId,
            senderUsername: currentAdmin.username,
            senderRole: 'admin',
            content: dataUrl,
            timestamp: new Date(),
            type: fileType
        };
        addMessageToChat(tempMessage, true);
        scrollToBottom();

        if (socket && socket.connected) {
            socket.emit('send_message', {
                content: dataUrl,
                receiverId: selectedUserId,
                type: fileType
            });

            sendPushNotification(selectedUserId, {
                type: fileType,
                content: fileLabel
            });

            showToast(`✅ ${fileLabel} enviada`, 'success');
        } else {
            const response = await fetch(`${API_URL}/api/messages/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentToken}`
                },
                body: JSON.stringify({
                    content: dataUrl,
                    receiverId: selectedUserId,
                    type: fileType
                })
            });

            if (!response.ok) {
                removeTempMessageEl(tempId);
                const errMsg = await parseFetchError(response, `No se pudo enviar ${fileLabel.toLowerCase()}`);
                showToast(`❌ ${fileLabel}: ${errMsg}`, 'error');
                return;
            }

            showToast(`✅ ${fileLabel} enviada`, 'success');
            loadMessages(selectedUserId, true);
        }
    } catch (error) {
        console.error('Error sending file:', error);
        removeTempMessageEl(tempId);
        showToast(`❌ Error al enviar ${fileLabel.toLowerCase()}`, 'error');
    } finally {
        if (sendingIndicator) sendingIndicator.classList.add('hidden');
        e.target.value = '';
    }
}

// Pegar imagen con Ctrl+V desde portapapeles (escritorio)
async function handleAdminPaste(e) {
    if (!selectedUserId) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;

    for (const item of items) {
        if (!item.type.startsWith('image/')) continue;
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        if (file.size > 30 * 1024 * 1024) {
            showToast('❌ La imagen es muy grande (máx 30 MB)', 'error');
            return;
        }

        const tempId = 'temp-image-' + Date.now();
        const sendingIndicator = document.getElementById('sendingIndicator');
        if (sendingIndicator) sendingIndicator.classList.remove('hidden');

        try {
            const dataUrl = await compressImageFile(file);

            const tempMessage = {
                id: tempId,
                senderId: currentAdmin.userId,
                senderUsername: currentAdmin.username,
                senderRole: 'admin',
                content: dataUrl,
                timestamp: new Date(),
                type: 'image'
            };
            addMessageToChat(tempMessage, true);
            scrollToBottom();

            if (socket && socket.connected) {
                socket.emit('send_message', {
                    content: dataUrl,
                    receiverId: selectedUserId,
                    type: 'image'
                });

                sendPushNotification(selectedUserId, { type: 'image', content: '📸 Imagen' });
                showToast('✅ Imagen enviada', 'success');
            } else {
                const response = await fetch(`${API_URL}/api/messages/send`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${currentToken}`
                    },
                    body: JSON.stringify({ content: dataUrl, receiverId: selectedUserId, type: 'image' })
                });
                if (!response.ok) {
                    removeTempMessageEl(tempId);
                    const errMsg = await parseFetchError(response, 'No se pudo enviar imagen');
                    showToast(`❌ 📸 Imagen: ${errMsg}`, 'error');
                    return;
                }
                showToast('✅ Imagen enviada', 'success');
                loadMessages(selectedUserId, true);
            }
        } catch (error) {
            console.error('Error sending pasted image:', error);
            removeTempMessageEl(tempId);
            showToast('❌ Error al enviar imagen', 'error');
        } finally {
            if (sendingIndicator) sendingIndicator.classList.add('hidden');
        }
        break;
    }
}


function handleTyping() {
    if (!selectedUserId) return;
    
    socket.emit('typing', { receiverId: selectedUserId });
    
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('stop_typing', { receiverId: selectedUserId });
    }, 2000);
}

function showTypingIndicator() {
    elements.typingIndicator.classList.remove('hidden');
}

function hideTypingIndicator() {
    elements.typingIndicator.classList.add('hidden');
}

// COMANDOS: Mostrar sugerencias de comandos
function showCommandSuggestions(inputValue) {
    const searchTerm = inputValue.slice(1).toLowerCase();
    
    // Filtrar comandos que coincidan
    commandSuggestions = availableCommands.filter(cmd => 
        cmd.name.toLowerCase().includes(searchTerm) || 
        (cmd.description && cmd.description.toLowerCase().includes(searchTerm))
    );
    
    if (commandSuggestions.length === 0) {
        hideCommandSuggestions();
        return;
    }
    
    // Crear o actualizar el contenedor de sugerencias
    let suggestionsContainer = document.getElementById('commandSuggestions');
    if (!suggestionsContainer) {
        suggestionsContainer = document.createElement('div');
        suggestionsContainer.id = 'commandSuggestions';
        suggestionsContainer.className = 'command-suggestions';
        suggestionsContainer.style.cssText = `
            position: absolute;
            bottom: 100%;
            left: 0;
            right: 0;
            background: white;
            border: 1px solid #ddd;
            border-radius: 8px 8px 0 0;
            max-height: 200px;
            overflow-y: auto;
            box-shadow: 0 -4px 12px rgba(0,0,0,0.15);
            z-index: 1000;
        `;
        elements.messageInput.parentElement.style.position = 'relative';
        elements.messageInput.parentElement.appendChild(suggestionsContainer);
    }
    
    // Renderizar sugerencias
    suggestionsContainer.innerHTML = commandSuggestions.map((cmd, index) => `
        <div class="command-suggestion-item ${index === selectedCommandIndex ? 'selected' : ''}" 
             data-index="${index}"
             style="padding: 10px 15px; cursor: pointer; border-bottom: 1px solid #eee; display: flex; align-items: center; gap: 10px;">
            <span style="font-weight: bold; color: #25d366;">${escapeHtml(cmd.name)}</span>
            <span style="color: #666; font-size: 0.85em;">${escapeHtml(cmd.description || '')}</span>
        </div>
    `).join('');
    
    // Agregar event listeners a cada sugerencia
    suggestionsContainer.querySelectorAll('.command-suggestion-item').forEach(item => {
        item.addEventListener('click', () => {
            const index = parseInt(item.dataset.index);
            insertCommand(commandSuggestions[index].name);
        });
        item.addEventListener('mouseenter', () => {
            selectedCommandIndex = parseInt(item.dataset.index);
            updateCommandSelection();
        });
    });
    
    suggestionsContainer.style.display = 'block';
}

// COMANDOS: Ocultar sugerencias
function hideCommandSuggestions() {
    const suggestionsContainer = document.getElementById('commandSuggestions');
    if (suggestionsContainer) {
        suggestionsContainer.style.display = 'none';
    }
    commandSuggestions = [];
    selectedCommandIndex = -1;
}

// COMANDOS: Actualizar selección visual
function updateCommandSelection() {
    const suggestionsContainer = document.getElementById('commandSuggestions');
    if (!suggestionsContainer) return;
    
    suggestionsContainer.querySelectorAll('.command-suggestion-item').forEach((item, index) => {
        if (index === selectedCommandIndex) {
            item.style.background = '#f0f0f0';
            item.classList.add('selected');
        } else {
            item.style.background = 'white';
            item.classList.remove('selected');
        }
    });
}

// COMANDOS: Insertar comando seleccionado
function insertCommand(commandName) {
    elements.messageInput.value = commandName + ' ';
    elements.messageInput.focus();
    hideCommandSuggestions();
}

// COMANDOS: Manejar teclas de navegación
function handleCommandKeydown(e) {
    if (commandSuggestions.length === 0) return;
    
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedCommandIndex = (selectedCommandIndex + 1) % commandSuggestions.length;
        updateCommandSelection();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedCommandIndex = (selectedCommandIndex - 1 + commandSuggestions.length) % commandSuggestions.length;
        updateCommandSelection();
    } else if (e.key === 'Tab' || e.key === 'Enter') {
        if (selectedCommandIndex >= 0) {
            e.preventDefault();
            insertCommand(commandSuggestions[selectedCommandIndex].name);
        }
    } else if (e.key === 'Escape') {
        hideCommandSuggestions();
    }
}

async function markMessagesAsRead(userId) {
    try {
        await fetch(`${API_URL}/api/messages/read/${userId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        // Actualizar conteo local de no leídos inmediatamente (optimistic update)
        const convIndex = conversations.findIndex(c => c.userId === userId);
        if (convIndex !== -1) {
            conversations[convIndex].unread = 0;
            conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
            renderConversations();
        }

        // Update unread count
        loadStats();
    } catch (error) {
        console.error('Error marking messages as read:', error);
    }
}

// ============================================
// USER ACTIONS
// ============================================
async function loadUserInfo(userId) {
    try {
        const response = await fetch(`${API_URL}/api/users/${userId}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load user info');
        
        const data = await response.json();
        const user = data.user;
        
        // RACE CONDITION FIX: Ignorar respuesta si ya no es el chat activo
        if (userId !== activeConversationId) {
            console.log('⚠️ Respuesta de userInfo de chat antiguo ignorada:', userId);
            return;
        }
        
        elements.chatBalance.textContent = formatMoney(user.balance);
        elements.chatStatus.textContent = user.online ? 'En línea' : 'Desconectado';
        elements.chatStatus.className = user.online ? 'status online' : 'status';

        // Reflejar estado de bloqueo en el header del chat
        applyBlockStateToChatHeader(user);
        
        // Mostrar estado de la app de notificaciones
        if (elements.chatAppStatus) {
            // Determinar el mejor estado a partir del array multi-token.
            // Si tiene cualquier token standalone → APP INSTALADA (prioridad máxima).
            // Si solo tiene tokens browser → NOTIS EN NAVEGADOR.
            // Si no tiene tokens → NOTIS INACTIVAS.
            const tokens = user.fcmTokens && user.fcmTokens.length > 0 ? user.fcmTokens : [];
            const hasStandalone = tokens.some(t => t.context === 'standalone' && t.token);
            const hasBrowser = tokens.some(t => t.context !== 'standalone' && t.token);
            // También considerar el campo individual por compatibilidad con cuentas antiguas
            const singleCtx = user.fcmTokenContext;
            const singleToken = user.fcmToken;
            const effectiveStandalone = hasStandalone || (singleToken && singleCtx === 'standalone');
            const effectiveBrowser = hasBrowser || (singleToken && singleCtx !== 'standalone');
            const hasAnyToken = tokens.length > 0 || !!singleToken;

            if (hasAnyToken) {
                // Determinar permiso: si tiene standalone, usar el permiso de ese token
                let perm = null;
                if (effectiveStandalone) {
                    const standaloneTk = tokens.find(t => t.context === 'standalone' && t.token);
                    perm = standaloneTk ? standaloneTk.notifPermission : (user.notifPermission || null);
                } else {
                    const browserTk = tokens.find(t => t.context !== 'standalone' && t.token);
                    perm = browserTk ? browserTk.notifPermission : (user.notifPermission || null);
                }
                // Fallback para cuentas antiguas sin notifPermission en token
                if (!perm) perm = user.notifPermission || null;

                if (effectiveStandalone) {
                    if (perm === 'denied') {
                        elements.chatAppStatus.textContent = '📱 APP - NOTIS BLOQUEADAS';
                        elements.chatAppStatus.style.color = '#ff6b6b';
                    } else {
                        elements.chatAppStatus.textContent = '📱 APP INSTALADA';
                        elements.chatAppStatus.style.color = '#00ff88';
                    }
                } else if (effectiveBrowser) {
                    if (perm === 'denied') {
                        elements.chatAppStatus.textContent = '🌐 NAVEGADOR - NOTIS BLOQUEADAS';
                        elements.chatAppStatus.style.color = '#ff6b6b';
                    } else {
                        elements.chatAppStatus.textContent = '🌐 NOTIS EN NAVEGADOR';
                        elements.chatAppStatus.style.color = '#4fc3f7';
                    }
                } else {
                    elements.chatAppStatus.textContent = '📵 NOTIS INACTIVAS';
                    elements.chatAppStatus.style.color = '#aaa';
                }
            } else {
                elements.chatAppStatus.textContent = '📵 NOTIS INACTIVAS';
                elements.chatAppStatus.style.color = '#aaa';
            }
        }
    } catch (error) {
        console.error('Error loading user info:', error);
    }
}

async function sendCBU() {
    if (!selectedUserId) return;
    
    const btnCBU = elements.btnCBU;
    setButtonLoading(btnCBU, true, 'Enviando...');
    
    try {
        const response = await fetch(`${API_URL}/api/admin/send-cbu`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ userId: selectedUserId })
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Error al enviar CBU');
        }
        
        showToast('CBU enviado correctamente', 'success');
        
        // Reload messages to show the CBU message
        loadMessages(selectedUserId);
        
    } catch (error) {
        console.error('Error sending CBU:', error);
        showToast(error.message || 'Error al enviar CBU', 'error');
    } finally {
        setButtonLoading(btnCBU, false, '<span class="icon icon-credit-card"></span> Enviar CBU');
    }
}

async function handleDeposit() {
    const amount = parseFloat(document.getElementById('depositAmount').value);
    const bonus = parseFloat(document.getElementById('depositBonus').value) || 0;
    const description = document.getElementById('depositDesc').value;
    const confirmBtn = document.getElementById('confirmDeposit');
    
    if (!amount || amount <= 0) {
        showToast('Ingresa un monto válido', 'error');
        return;
    }
    
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    // Loading state
    setButtonLoading(confirmBtn, true, 'Procesando...');
    
    try {
        const response = await fetch(`${API_URL}/api/admin/deposit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: selectedUserId,
                amount,
                bonus,
                description
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Error al realizar depósito');
        }
        
        showToast(`Depósito de ${formatMoney(amount + bonus)} realizado`, 'success');
        hideModal('depositModal');
        
        // Reset deposit form
        document.getElementById('depositAmount').value = '';
        document.getElementById('depositBonus').value = '';
        document.getElementById('depositDesc').value = '';
        document.querySelectorAll('.bonus-options button').forEach(b => b.classList.remove('active'));
        const noBonusBtn = document.querySelector('.bonus-options button[data-bonus="0"]');
        if (noBonusBtn) noBonusBtn.classList.add('active');
        
        // Update balance display
        loadUserInfo(selectedUserId);
        
        // Reload messages to show deposit notification
        loadMessages(selectedUserId);
        
    } catch (error) {
        console.error('Error depositing:', error);
        showToast(error.message || 'Error al realizar depósito', 'error');
    } finally {
        setButtonLoading(confirmBtn, false, 'Confirmar Depósito');
    }
}

async function handleWithdraw() {
    const amount = parseFloat(document.getElementById('withdrawAmount').value);
    const description = document.getElementById('withdrawDesc').value;
    const confirmBtn = document.getElementById('confirmWithdraw');
    
    if (!amount || amount <= 0) {
        showToast('Ingresa un monto válido', 'error');
        return;
    }
    
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    // Loading state
    setButtonLoading(confirmBtn, true, 'Procesando...');
    
    try {
        const response = await fetch(`${API_URL}/api/admin/withdrawal`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: selectedUserId,
                amount,
                description
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || data.message || 'Error al realizar retiro');
        }
        
        showToast(`Retiro de ${formatMoney(amount)} realizado`, 'success');
        hideModal('withdrawModal');
        
        // Reset withdrawal form
        document.getElementById('withdrawAmount').value = '';
        document.getElementById('withdrawDesc').value = '';
        
        // Update balance display
        loadUserInfo(selectedUserId);
        
        // Reload messages to show withdrawal notification
        loadMessages(selectedUserId);
        
    } catch (error) {
        console.error('Error withdrawing:', error);
        showToast(error.message || 'Error al realizar retiro', 'error');
    } finally {
        setButtonLoading(confirmBtn, false, 'Confirmar Retiro');
    }
}

async function handleDirectBonus() {
    const amount = parseFloat(document.getElementById('bonusAmount').value);
    const description = document.getElementById('bonusDesc').value;
    const confirmBtn = document.getElementById('confirmBonus');

    if (!amount || amount <= 0) {
        showToast('Ingresa un monto válido', 'error');
        return;
    }

    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }

    setButtonLoading(confirmBtn, true, 'Procesando...');

    try {
        const response = await fetch(`${API_URL}/api/admin/bonus`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: selectedUserId,
                amount,
                description
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Error al aplicar bonus');
        }

        showToast(`Bonus de ${formatMoney(amount)} aplicado`, 'success');
        hideModal('bonusModal');
        document.getElementById('bonusAmount').value = '';
        document.getElementById('bonusDesc').value = '';

        loadUserInfo(selectedUserId);
        loadMessages(selectedUserId);

    } catch (error) {
        console.error('Error applying bonus:', error);
        showToast(error.message || 'Error al aplicar bonus', 'error');
    } finally {
        setButtonLoading(confirmBtn, false, 'Confirmar Bonus');
    }
}

async function handlePasswordChange() {
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const confirmBtn = document.getElementById('confirmPasswordChange');
    
    if (!newPassword || newPassword.length < 6) {
        showToast('La contraseña debe tener al menos 6 caracteres', 'error');
        return;
    }
    
    if (newPassword !== confirmPassword) {
        showToast('Las contraseñas no coinciden', 'error');
        return;
    }
    
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    // Verificar permisos según rol
    const adminRole = currentAdmin?.role;
    // Prefer the role stored when the modal was opened (users-table flow), then
    // fall back to the conversations list (chat-panel flow).
    const targetUser = conversations.find(c => c.userId === selectedUserId);
    const targetUserRole = selectedUserRole || targetUser?.role || 'user';
    
    // Admin general puede cambiar contraseña de TODOS incluyendo admins
    // Admin depositer puede cambiar contraseña de usuarios pero NO de admins
    // Admin withdrawer NO puede cambiar contraseñas
    if (adminRole === 'withdrawer') {
        showToast('No tienes permiso para cambiar contraseñas', 'error');
        return;
    }
    
    if (adminRole === 'depositor' && targetUserRole !== 'user') {
        showToast('Solo puedes cambiar contraseñas de usuarios, no de administradores', 'error');
        return;
    }
    
    // Loading state
    setButtonLoading(confirmBtn, true, 'Cambiando...');
    
    try {
        const response = await fetch(`${API_URL}/api/admin/change-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: selectedUserId,
                newPassword
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Error al cambiar contraseña');
        }
        
        showToast(`Contraseña actualizada correctamente`, 'success');
        hideModal('passwordModal');
        selectedUserRole = null;
        
        // Clear inputs
        document.getElementById('newPassword').value = '';
        document.getElementById('confirmPassword').value = '';
        
    } catch (error) {
        console.error('Error changing password:', error);
        showToast(error.message || 'Error al cambiar contraseña', 'error');
    } finally {
        setButtonLoading(confirmBtn, false, 'Cambiar Contraseña');
    }
}

async function sendToPayments() {
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    const btnPayments = elements.btnPayments;
    setButtonLoading(btnPayments, true, 'Enviando...');
    
    // Optimistic UI - clear chat panel immediately
    const userIdToRemove = selectedUserId;
    selectedUserId = null;
    activeConversationId = null; // RACE CONDITION FIX
    elements.chatHeader.classList.add('hidden');
    elements.chatInputArea.classList.add('hidden');
    elements.chatMessages.innerHTML = `
        <div class="empty-state">
            <span class="icon icon-comment-dots"></span>
            <p>Chat enviado a pagos...</p>
        </div>
    `;
    
    // Remove from conversations list immediately
    const convItem = document.querySelector(`.conversation-item[data-userid="${userIdToRemove}"]`);
    if (convItem) {
        convItem.style.opacity = '0.5';
        convItem.style.pointerEvents = 'none';
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/send-to-payments`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ userId: userIdToRemove })
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Error al enviar a pagos');
        }
        
        showToast('Chat enviado a pagos correctamente', 'success');
        
        // Remove from list immediately
        if (convItem) {
            convItem.remove();
        }
        
        // Invalidar cache y recargar en background
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('closed');
        conversationsCacheByTab.delete('payments');
        loadConversations();
        
    } catch (error) {
        console.error('Error sending to payments:', error);
        showToast(error.message || 'Error al enviar a cargas', 'error');
        // Restore UI on error
        if (convItem) {
            convItem.style.opacity = '1';
            convItem.style.pointerEvents = 'auto';
        }
    } finally {
        setButtonLoading(btnPayments, false, '<span class="icon icon-exchange"></span> Enviar a Pagos');
    }
}

// Enviar a Abiertos (nueva función para cuando está en Pagos)
async function sendToOpen() {
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    const btnPayments = elements.btnPayments;
    setButtonLoading(btnPayments, true, 'Enviando...');
    
    // Optimistic UI - clear chat panel immediately
    const userIdToRemove = selectedUserId;
    selectedUserId = null;
    activeConversationId = null; // RACE CONDITION FIX
    elements.chatHeader.classList.add('hidden');
    elements.chatInputArea.classList.add('hidden');
    elements.chatMessages.innerHTML = `
        <div class="empty-state">
            <span class="icon icon-comment-dots"></span>
            <p>Chat enviado a abiertos...</p>
        </div>
    `;
    
    // Remove from conversations list immediately
    const convItem = document.querySelector(`.conversation-item[data-userid="${userIdToRemove}"]`);
    if (convItem) {
        convItem.style.opacity = '0.5';
        convItem.style.pointerEvents = 'none';
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/send-to-open`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ userId: userIdToRemove })
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Error al enviar a abiertos');
        }
        
        showToast('Chat enviado a abiertos correctamente', 'success');
        
        // Remove from list immediately
        if (convItem) {
            convItem.remove();
        }
        
        // Invalidar cache y recargar en background
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('closed');
        conversationsCacheByTab.delete('payments');
        loadConversations();
        
    } catch (error) {
        console.error('Error sending to open:', error);
        showToast(error.message || 'Error al enviar a abiertos', 'error');
        // Restore UI on error
        if (convItem) {
            convItem.style.opacity = '1';
            convItem.style.pointerEvents = 'auto';
        }
    } finally {
        setButtonLoading(btnPayments, false, '<span class="icon icon-exchange"></span> Enviar a Abiertos');
    }
}

// Función para deseleccionar el chat (sin cerrarlo)
function deselectChat() {
    if (!selectedUserId) return;
    
    // RACE CONDITION FIX: Cancelar fetch en curso y limpiar id activo
    if (activeFetchController) {
        activeFetchController.abort();
        activeFetchController = null;
    }
    activeConversationId = null;

    // Salir de la sala de chat
    if (socket) {
        socket.emit('leave_chat_room', { userId: selectedUserId });
    }
    
    // Limpiar selección visual
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Ocultar panel de chat
    selectedUserId = null;
    selectedUsername = null;
    elements.chatHeader.classList.add('hidden');
    elements.chatInputArea.classList.add('hidden');
    if (elements.chatAppStatus) {
        elements.chatAppStatus.textContent = '';
    }
    elements.chatMessages.innerHTML = `
        <div class="empty-state">
            <span class="icon icon-comment-dots"></span>
            <p>Selecciona una conversación para ver los mensajes</p>
        </div>
    `;
    
    console.log('👋 Chat deseleccionado');
}

async function closeChat() {
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    const btnClose = elements.btnClose;
    setButtonLoading(btnClose, true, 'Cerrando...');
    
    // Optimistic UI - update immediately
    const userIdToClose = selectedUserId;
    
    // Move conversation to closed tab visually
    const convItem = document.querySelector(`.conversation-item[data-userid="${userIdToClose}"]`);
    if (convItem) {
        convItem.style.opacity = '0.5';
    }
    
    // COMPORTAMIENTO DIFERENTE SEGÚN LA PESTAÑA:
    // - En "Abiertos": Mantener chat abierto para seguir respondiendo
    // - En "Pagos": Cerrar el chat completamente
    const isPaymentsTab = currentTab === 'payments';
    
    if (isPaymentsTab) {
        // En pagos: cerrar completamente
        selectedUserId = null;
        elements.chatHeader.classList.add('hidden');
        elements.chatInputArea.classList.add('hidden');
        elements.chatMessages.innerHTML = `
            <div class="empty-state">
                <span class="icon icon-comment-dots"></span>
                <p>Chat cerrado. Selecciona otra conversación.</p>
            </div>
        `;
    }
    // Fix #3: No insertar mensaje de cierre en el DOM manualmente; el backend lo guarda
    // en la DB como adminOnly y se muestra al recargar mensajes.
    
    try {
        const response = await fetch(`${API_URL}/api/admin/close-chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ 
                userId: userIdToClose,
                notifyClient: false, // No notificar al cliente, solo interno
                isPaymentsTab: isPaymentsTab
            })
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Error al cerrar chat');
        }
        
        showToast('Chat cerrado correctamente', 'success');
        
        // If on open tab, remove from list
        if (currentTab === 'open' && convItem) {
            convItem.remove();
        }
        
        // Fix #3: Recargar mensajes para mostrar el mensaje de cierre guardado en DB
        if (!isPaymentsTab && selectedUserId === userIdToClose) {
            messageCache.delete(userIdToClose);
            loadMessages(userIdToClose);
        }
        
        // Invalidar cache y recargar en background
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('closed');
        loadConversations();
        
    } catch (error) {
        console.error('Error closing chat:', error);
        showToast(error.message || 'Error al cerrar chat', 'error');
        // Restore UI on error
        if (convItem) {
            convItem.style.opacity = '1';
        }
    } finally {
        setButtonLoading(btnClose, false, '<span class="icon icon-lock"></span> Cerrar Chat');
    }
}

// ============================================
// DATOS (métricas de adquisición, actividad y recurrencia)
// ============================================
let datosPeriod = 'today';

function setDatosPeriod(period) {
    datosPeriod = period;
    // Limpiar fecha exacta y rango
    const fechaInput = document.getElementById('datosFecha');
    if (fechaInput) fechaInput.value = '';
    const desdeInput = document.getElementById('datosDesde');
    if (desdeInput) desdeInput.value = '';
    const hastaInput = document.getElementById('datosHasta');
    if (hastaInput) hastaInput.value = '';
    // Resaltar botón activo
    document.querySelectorAll('.datos-period-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.period === period);
    });
    loadDatos();
}

function setDatosDate(date) {
    if (!date) return;
    datosPeriod = null;
    const desdeInput = document.getElementById('datosDesde');
    if (desdeInput) desdeInput.value = '';
    const hastaInput = document.getElementById('datosHasta');
    if (hastaInput) hastaInput.value = '';
    document.querySelectorAll('.datos-period-btn').forEach(btn => btn.classList.remove('active'));
    loadDatos();
}

function applyDatosRange() {
    const desde = document.getElementById('datosDesde')?.value;
    const hasta = document.getElementById('datosHasta')?.value;
    if (!desde || !hasta) {
        showToast('Seleccioná fecha desde y hasta', 'error');
        return;
    }
    datosPeriod = null;
    const fechaInput = document.getElementById('datosFecha');
    if (fechaInput) fechaInput.value = '';
    document.querySelectorAll('.datos-period-btn').forEach(btn => btn.classList.remove('active'));
    loadDatos();
}

async function loadDatos() {
    try {
        const fechaInput = document.getElementById('datosFecha');
        const fecha = fechaInput ? fechaInput.value : '';
        const desde = document.getElementById('datosDesde')?.value || '';
        const hasta = document.getElementById('datosHasta')?.value || '';

        let url;
        if (desde && hasta) {
            url = `${API_URL}/api/admin/datos?dateFrom=${encodeURIComponent(desde)}&dateTo=${encodeURIComponent(hasta)}`;
        } else if (fecha) {
            url = `${API_URL}/api/admin/datos?date=${encodeURIComponent(fecha)}`;
        } else {
            url = `${API_URL}/api/admin/datos?period=${datosPeriod || 'today'}`;
        }

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!response.ok) throw new Error('Failed to load datos');
        const json = await response.json();
        const d = json.data || {};

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = (val !== undefined && val !== null) ? val : '—';
        };
        const setAmt = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = (val !== undefined && val !== null)
                ? '$\u202F' + Number(val).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
                : '—';
        };
        const setPct = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = (val !== undefined && val !== null) ? val + '%' : '—';
        };

        // Período activo
        const periodLabel = document.getElementById('datosPeriodLabel');
        if (periodLabel && d.period) periodLabel.textContent = '— ' + d.period.label;

        const a = d.acquisition      || {};
        const b = d.depositActivity  || {};
        const c = d.economicQuality  || {};
        const r = d.recurrence       || {};

        // Bloque A — Adquisición
        set('datosRegisteredUsers',  a.registeredUsers);
        set('datosFirstDepositUsers', a.firstDepositUsers);
        setPct('datosConversionRate', a.conversionRate);
        set('datosNeverDeposited',   a.registeredNeverDeposited);

        // Bloque B — Actividad de depósitos
        set('datosTotalDeposits',          b.totalDeposits);
        set('datosUniqueDepositors',       b.uniqueDepositors);
        set('datosFirstTimeDeposits',      b.firstTimeDeposits);
        set('datosFirstTimeDepositUsers',  b.firstTimeDepositUsers);
        set('datosReturningDeposits',      b.returningDeposits);
        set('datosReturningUsers',         b.returningDepositUsers);
        set('datosFrequency',              b.depositFrequency);

        // Bloque C — Calidad económica
        setAmt('datosTotalAmount',       c.totalAmount);
        setAmt('datosAvgTicket',         c.avgTicket);
        setAmt('datosAvgPerDepositor',   c.avgPerDepositor);
        setAmt('datosFirstTimeAmount',   c.firstTimeAmount);
        setAmt('datosReturningAmount',   c.returningAmount);

        // Bloque D — Recurrencia
        set('datosActiveReturning',  r.activeReturningUsers);
        setPct('datosReturningPct',  r.returningPct);
        set('datosMultipleUsers',    r.multipleDepositUsers);
        setPct('datosRepeatRate',    r.repeatRate);

        // Bloque E — Retención (tiempo real)
        const e = d.retention || {};
        set('datosRetention3d',  e.users3d);
        set('datosRetention7d',  e.users7d);
        set('datosRetention15d', e.users15d);
        set('datosRetention30d', e.users30d);

    } catch (error) {
        console.error('Error loading datos:', error);
    }
}

// ============================================
// STATS
// ============================================
async function loadStats() {
    try {
        const response = await fetch(`${API_URL}/api/admin/stats`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load stats');
        
        const json = await response.json();
        // CORREGIDO: extraer data.data si existe (respuesta envuelta)
        const data = json.data || json;
        updateStats(data);
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

function updateStats(data) {
    elements.statUsers.textContent = data.totalUsers || 0;
    // CORREGIDO: usar connectedUsers (socket) o onlineUsers (HTTP)
    elements.statOnline.textContent = data.connectedUsers !== undefined ? data.connectedUsers : (data.onlineUsers || 0);
    elements.statMessages.textContent = data.totalMessages || 0;
    elements.statUnread.textContent = data.unreadMessages || 0;
    
    // Update badge
    if (data.unreadMessages > 0) {
        elements.unreadBadge.textContent = data.unreadMessages;
        elements.unreadBadge.classList.remove('hidden');
    } else {
        elements.unreadBadge.classList.add('hidden');
    }
}

function incrementUnreadCount() {
    const current = parseInt(elements.statUnread.textContent) || 0;
    elements.statUnread.textContent = current + 1;
    elements.unreadBadge.textContent = current + 1;
    elements.unreadBadge.classList.remove('hidden');
}

// ============================================
// USERS SECTION
// ============================================
let allUsersCache = [];

async function loadUsers() {
    try {
        const response = await fetch(`${API_URL}/api/admin/users`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load users');
        
        const data = await response.json();
        allUsersCache = data.users || [];
        filterAndRenderUsers();
    } catch (error) {
        console.error('Error loading users:', error);
    }
}

function filterAndRenderUsers() {
    const searchInput = document.getElementById('searchUsers');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
    if (!query) {
        renderUsers(allUsersCache);
        return;
    }
    const filtered = allUsersCache.filter(u => {
        return (
            (u.username && u.username.toLowerCase().includes(query)) ||
            (u.id && String(u.id).toLowerCase().includes(query)) ||
            (u.accountId && String(u.accountId).toLowerCase().includes(query)) ||
            (u.phone && u.phone.toLowerCase().includes(query)) ||
            (u.email && u.email.toLowerCase().includes(query))
        );
    });
    renderUsers(filtered);
}

// Exportar todos los usuarios a CSV (solo admin general)
async function exportUsersCSV() {
    if (currentAdmin?.role !== 'admin') {
        showToast('No tienes permiso para exportar usuarios', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/users/export/csv`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to export users');
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `usuarios_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        showToast('Usuarios exportados correctamente', 'success');
    } catch (error) {
        console.error('Error exporting users:', error);
        showToast('Error al exportar usuarios', 'error');
    }
}

function renderUsers(users) {
    const tbody = document.getElementById('usersTableBody');
    const adminRole = currentAdmin?.role;
    
    if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No hay usuarios</td></tr>';
        return;
    }
    
    tbody.innerHTML = users.map(user => {
        const isAdminUser = ['admin', 'depositor', 'withdrawer'].includes(user.role);
        const canChangePassword = adminRole === 'admin' || (adminRole === 'depositor' && !isAdminUser);
        const canBlock = adminRole === 'admin' && !isAdminUser;

        // Status cell: show BLOQUEADO badge if blocked
        let statusCell;
        if (user.isBlocked) {
            const reason = user.blockReason ? escapeHtml(user.blockReason).replace(/"/g, '&quot;') : 'Sin motivo registrado';
            statusCell = `<span class="status-badge blocked" title="${reason}" style="background:#dc3545;color:#fff;cursor:default;">BLOQUEADO</span>`;
        } else {
            statusCell = `<span class="status-badge ${user.status}">${escapeHtml(user.status)}</span>`;
        }

        // ROOT CAUSE FIX: los onclick deben usar comillas SIMPLES como
        // delimitador de atributo porque JSON.stringify produce strings con
        // comillas dobles ("abc"). Si el atributo se delimita con dobles, el
        // browser parsea onclick="fn(" y descarta el resto → ningún botón
        // ejecutaba su handler. Con comillas simples afuera, las dobles del
        // JSON conviven sin colisión: onclick='fn("abc", "pepe")'.
        const pwdBtn = canChangePassword
            ? `<button class="action-btn-small" title="Cambiar contraseña" onclick='openUserPasswordModal(${JSON.stringify(user.id)}, ${JSON.stringify(user.username)}, ${JSON.stringify(user.role)})'><span class="icon icon-key"></span></button>`
            : '';

        let blockBtn = '';
        if (canBlock) {
            if (user.isBlocked) {
                blockBtn = `<button class="action-btn-small" title="Desbloquear usuario" onclick='handleUnblockUser(${JSON.stringify(user.id)}, ${JSON.stringify(user.username)})'><span class="icon icon-lock-open"></span></button>`;
            } else {
                blockBtn = `<button class="action-btn-small" style="color:#dc3545" title="Bloquear usuario" onclick='openBlockModal(${JSON.stringify(user.id)}, ${JSON.stringify(user.username)})'><span class="icon icon-ban"></span></button>`;
            }
        }

        return `
        <tr class="${isAdminUser ? 'admin-row' : ''}">
            <td>${escapeHtml(user.username)}</td>
            <td>${escapeHtml(user.accountId || '-')}</td>
            <td>${escapeHtml(user.email || '-')}</td>
            <td>${escapeHtml(user.phone || '-')}</td>
            <td><span class="role-badge ${user.role}">${getRoleLabel(user.role)}</span></td>
            <td>${formatMoney(user.balance)}</td>
            <td>${statusCell}</td>
            <td>${formatDate(user.lastLogin)}</td>
            <td>
                <button class="action-btn-small" title="Ver detalle" onclick='viewUser(${JSON.stringify(user.id)})'>
                    <span class="icon icon-eye"></span>
                </button>
                <button class="action-btn-small" title="Ir al chat" onclick='chatUser(${JSON.stringify(user.id)})'>
                    <span class="icon icon-comment"></span>
                </button>
                ${pwdBtn}
                ${blockBtn}
            </td>
        </tr>
        `;
    }).join('');
}

// ============================================
// USER ACTIONS — Password change & Block/Unblock
// ============================================

// Opens the existing passwordModal pre-filled for a specific user from the table.
function openUserPasswordModal(userId, username, userRole) {
    selectedUserId = userId;
    selectedUserRole = userRole;
    // Update modal title to show which user's password is being changed
    const modalHeader = document.querySelector('#passwordModal .modal-header h3');
    if (modalHeader) {
        modalHeader.innerHTML = `<span class="icon icon-key"></span> Cambiar contraseña: ${escapeHtml(username)}`;
    }
    // Ensure close/cancel buttons are visible (they may have been hidden by the forced-change flow)
    const closeBtn = document.querySelector('#passwordModal .close-modal');
    if (closeBtn) closeBtn.style.display = '';
    const cancelBtn = document.querySelector('#passwordModal .btn-secondary');
    if (cancelBtn) cancelBtn.style.display = '';
    // Clear previous values
    const np = document.getElementById('newPassword');
    const cp = document.getElementById('confirmPassword');
    if (np) np.value = '';
    if (cp) cp.value = '';
    showModal('passwordModal');
}

// Opens the block modal for a specific user.
function openBlockModal(userId, username) {
    selectedUserForBlock = { id: userId, username };
    const titleEl = document.getElementById('blockModalUsername');
    if (titleEl) titleEl.textContent = username;
    const reasonEl = document.getElementById('blockReasonInput');
    if (reasonEl) reasonEl.value = '';
    const confirmBtn = document.getElementById('confirmBlockBtn');
    if (confirmBtn) confirmBtn.disabled = true;
    showModal('blockModal');
}

// Handles submitting the block form.
async function handleBlockUser() {
    if (!selectedUserForBlock) return;
    const reasonEl = document.getElementById('blockReasonInput');
    const reason = reasonEl ? reasonEl.value.trim() : '';
    if (reason.length < 5) {
        showToast('El motivo debe tener al menos 5 caracteres', 'error');
        return;
    }
    const confirmBtn = document.getElementById('confirmBlockBtn');
    setButtonLoading(confirmBtn, true, 'Bloqueando...');
    try {
        const response = await fetch(`${API_URL}/api/admin/users/${encodeURIComponent(selectedUserForBlock.id)}/block`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ reason })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Error al bloquear usuario');
        showToast(`Usuario ${selectedUserForBlock.username} bloqueado`, 'success');
        hideModal('blockModal');
        // Si el usuario bloqueado es el del chat activo, refrescar header
        if (selectedUserForBlock.id === selectedUserId) {
            loadUserInfo(selectedUserForBlock.id);
        }
        // Refrescar tabla de usuarios solo si la sección está visible
        if (typeof loadUsers === 'function' && document.getElementById('usersSection')?.classList.contains('active')) {
            loadUsers();
        }
    } catch (error) {
        showToast(error.message || 'Error al bloquear usuario', 'error');
    } finally {
        setButtonLoading(confirmBtn, false, 'Bloquear usuario');
    }
}

// Handles unblocking a user directly (with a simple confirm dialog).
async function handleUnblockUser(userId, username) {
    if (!confirm(`¿Desbloquear a ${username}?`)) return;
    try {
        const response = await fetch(`${API_URL}/api/admin/users/${encodeURIComponent(userId)}/unblock`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Error al desbloquear usuario');
        showToast(`Usuario ${username} desbloqueado`, 'success');
        loadUsers();
    } catch (error) {
        showToast(error.message || 'Error al desbloquear usuario', 'error');
    }
}

window.openUserPasswordModal = openUserPasswordModal;
window.openBlockModal = openBlockModal;
window.handleBlockUser = handleBlockUser;
window.handleUnblockUser = handleUnblockUser;

// Pinta el banner BLOQUEADO + alterna botones Bloquear/Desbloquear según el estado del user.
// El banner muestra motivo y QUIÉN lo bloqueó — esta info es solo para admins
// (el usuario nunca la ve: el cliente solo recibe el motivo en el login bloqueado,
// nunca el blockedBy).
function applyBlockStateToChatHeader(user) {
    if (!user) return;
    const isBlocked = user.isBlocked === true;
    const reason = user.blockReason || 'Sin motivo registrado';
    const blockedBy = user.blockedBy || null;
    const blockedAt = user.blockedAt ? new Date(user.blockedAt) : null;
    const isAdminUser = ['admin', 'depositor', 'withdrawer'].includes(user.role);
    // Tanto admin general como depositor pueden bloquear (son los que operan en el chat).
    const canBlock = ['admin', 'depositor'].includes(currentAdmin?.role) && !isAdminUser;

    if (elements.chatBlockedBanner) {
        elements.chatBlockedBanner.style.display = isBlocked ? 'block' : 'none';
    }
    if (elements.chatBlockedReason) {
        if (isBlocked) {
            const lines = [`Motivo: ${reason}`];
            if (blockedBy) {
                let byLine = `Bloqueado por: ${blockedBy}`;
                if (blockedAt && !isNaN(blockedAt.getTime())) {
                    byLine += ` — ${blockedAt.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}`;
                }
                lines.push(byLine);
            }
            elements.chatBlockedReason.innerHTML = lines.map(escapeHtml).join('<br>');
        } else {
            elements.chatBlockedReason.textContent = '';
        }
    }

    if (elements.btnBlock) {
        elements.btnBlock.style.display = (canBlock && !isBlocked) ? '' : 'none';
    }
    if (elements.btnUnblock) {
        elements.btnUnblock.style.display = (canBlock && isBlocked) ? '' : 'none';
    }
}

// Abre el modal de bloqueo desde el header del chat (usa el chat seleccionado)
function openBlockModalFromChat() {
    if (!selectedUserId || !selectedUsername) {
        showToast('Seleccioná un chat primero', 'error');
        return;
    }
    openBlockModal(selectedUserId, selectedUsername);
}

// Desbloquea desde el header del chat y refresca el header
async function handleUnblockFromChat() {
    if (!selectedUserId || !selectedUsername) {
        showToast('Seleccioná un chat primero', 'error');
        return;
    }
    if (!confirm(`¿Desbloquear a ${selectedUsername}?`)) return;
    const userId = selectedUserId;
    const username = selectedUsername;
    try {
        const response = await fetch(`${API_URL}/api/admin/users/${encodeURIComponent(userId)}/unblock`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Error al desbloquear usuario');
        showToast(`Usuario ${username} desbloqueado`, 'success');
        // Refrescar header con el estado nuevo
        if (userId === selectedUserId) loadUserInfo(userId);
    } catch (error) {
        showToast(error.message || 'Error al desbloquear usuario', 'error');
    }
}

window.applyBlockStateToChatHeader = applyBlockStateToChatHeader;
window.openBlockModalFromChat = openBlockModalFromChat;
window.handleUnblockFromChat = handleUnblockFromChat;

// ============================================
// UI HELPERS
// ============================================
function switchSection(section) {
    // CORREGIDO: Solo admin general puede acceder a "Usuarios"
    if (section === 'users' && currentAdmin?.role !== 'admin') {
        showToast('No tienes permiso para acceder a esta sección', 'error');
        return;
    }
    
    // Update nav
    elements.navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.section === section);
    });
    
    // Update sections
    elements.sections.forEach(sec => {
        sec.classList.toggle('active', sec.id === `${section}Section`);
    });
    
    // Load section data
    if (section === 'users') loadUsers();
    if (section === 'transactions') loadTransactions();
    if (section === 'commands') loadCommands();
    if (section === 'datos') loadDatos();
    if (section === 'notifications') loadNotificationsPanel();
    if (section === 'referrals') loadAdminReferralSummary();
    if (section === 'sms') {
        if (currentAdmin?.role !== 'admin') {
            showToast('No tienes permiso para acceder a esta sección', 'error');
            return;
        }
        if (!smsAccessGranted) {
            showSmsPasswordModal();
        } else {
            document.getElementById('smsSectionContent').classList.remove('hidden');
        }
    }
    if (section === 'database') {
        if (!dbAccessGranted) {
            showDatabasePasswordModal();
        } else {
            loadDatabaseUsers();
        }
    }
}

function showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }
}

function hideModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('hidden');
        document.body.style.overflow = '';
    }
}

function calculateBonus() {
    const amount = parseFloat(document.getElementById('depositAmount').value) || 0;
    const activeBonus = document.querySelector('.bonus-options button.active');
    const bonusPercent = activeBonus ? parseFloat(activeBonus.dataset.bonus) : 0;
    
    const bonusAmount = Math.floor(amount * (bonusPercent / 100));
    document.getElementById('depositBonus').value = bonusAmount;
}

function scrollToBottom() {
    // CORREGIDO: Scroll suave al final del contenedor
    if (elements.chatMessages) {
        elements.chatMessages.scrollTo({
            top: elements.chatMessages.scrollHeight,
            behavior: 'smooth'
        });
        // Asegurar que llegue al final
        elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    }
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const iconClass = type === 'success' ? 'icon-check' : type === 'error' ? 'icon-times-circle' : type === 'warning' ? 'icon-exclamation' : 'icon-info';
    toast.innerHTML = `
        <span class="icon ${iconClass}"></span>
        <span>${message}</span>
    `;
    
    elements.toastContainer.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function playNotificationSound() {
    // Sonido de notificación para nuevos mensajes
    try {
        // Crear un beep simple usando Web Audio API
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.frequency.value = 800;
        oscillator.type = 'sine';
        
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.5);
    } catch (e) {
        console.log('No se pudo reproducir sonido:', e);
    }
}

function updateUserStatus(userId, online) {
    if (userId === selectedUserId) {
        elements.chatStatus.textContent = online ? 'En línea' : 'Desconectado';
        elements.chatStatus.className = online ? 'status online' : 'status';
    }
}

// ============================================
// UTILITIES
// ============================================
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatMoney(amount) {
    if (amount === undefined || amount === null) return '$0';
    return '$' + parseFloat(amount).toLocaleString('es-AR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    });
}

function formatDate(date) {
    if (!date) return 'Nunca';
    const d = new Date(date);
    return d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
}

function formatTime(date) {
    if (!date) return '';
    const d = new Date(date);
    const now = new Date();
    const diff = now - d;
    
    if (diff < 60000) return 'Ahora';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000) return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
}

function formatDateTime(date) {
    if (!date) return '';
    const d = new Date(date);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const dateOpts = { timeZone: 'America/Argentina/Buenos_Aires' };
    const dStr = d.toLocaleDateString('es-AR', dateOpts);
    const todayStr = today.toLocaleDateString('es-AR', dateOpts);
    const yesterdayStr = yesterday.toLocaleDateString('es-AR', dateOpts);

    const time = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });

    if (dStr === todayStr) return `Hoy ${time}`;
    if (dStr === yesterdayStr) return `Ayer ${time}`;

    return d.toLocaleDateString('es-AR', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        timeZone: 'America/Argentina/Buenos_Aires'
    }) + ' ' + time;
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ============================================
// WITHDRAW TOTAL UPDATE
// ============================================
function updateWithdrawTotal() {
    const amount = parseInt(document.getElementById('withdrawAmount').value) || 0;
    const totalDisplay = document.getElementById('withdrawTotal');
    if (totalDisplay) {
        totalDisplay.textContent = formatMoney(amount);
    }
}

// Seleccionar todo el saldo del usuario
async function selectAllBalance() {
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/balance/${selectedUsername}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            const balance = data.balance || 0;
            document.getElementById('withdrawAmount').value = balance;
            updateWithdrawTotal();
            showToast(`Saldo seleccionado: ${formatMoney(balance)}`, 'success');
        } else {
            showToast('No se pudo obtener el saldo del usuario', 'error');
        }
    } catch (error) {
        console.error('Error obteniendo saldo:', error);
        showToast('Error al obtener el saldo', 'error');
    }
}

// ============================================
// BUTTON LOADING STATE
// ============================================
function setButtonLoading(button, isLoading, loadingText = 'Cargando...') {
    if (!button) return;
    
    if (isLoading) {
        button.dataset.originalText = button.innerHTML;
        button.innerHTML = `<span class="icon icon-sync" style="animation: spin 1s linear infinite;"></span> ${loadingText}`;
        button.disabled = true;
        button.style.opacity = '0.7';
        button.style.cursor = 'not-allowed';
    } else {
        button.innerHTML = button.dataset.originalText || loadingText;
        button.disabled = false;
        button.style.opacity = '1';
        button.style.cursor = 'pointer';
    }
}

// ============================================
// TRANSACTIONS DASHBOARD
// ============================================
let transactionsData = [];
let transactionsFilter = 'all';
let transactionDateFrom = '';
let transactionDateTo = '';
let transactionUsernameFilter = '';

async function loadTransactions() {
    try {
        let url = `${API_URL}/api/admin/transactions`;
        const params = [];
        
        if (transactionDateFrom) {
            params.push(`from=${transactionDateFrom}`);
        }
        if (transactionDateTo) {
            params.push(`to=${transactionDateTo}`);
        }
        if (transactionUsernameFilter) {
            params.push(`username=${encodeURIComponent(transactionUsernameFilter)}`);
        }
        
        if (params.length > 0) {
            url += '?' + params.join('&');
        }
        
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load transactions');
        
        const data = await response.json();
        transactionsData = data.transactions || [];
        renderTransactions(transactionsData);
        renderTransactionStats(data.summary || {});
    } catch (error) {
        console.error('Error loading transactions:', error);
    }
}

function renderTransactionStats(summary) {
    const statsContainer = document.getElementById('transactionStats');
    if (statsContainer) {
        const netBalance = (summary.deposits || 0) - (summary.withdrawals || 0);
        const netBalanceClass = netBalance >= 0 ? '' : 'negative';
        
        statsContainer.innerHTML = `
            <div class="stat-card deposit">
                <span class="icon icon-plus-circle"></span>
                <span class="stat-number">${formatMoney(summary.deposits || 0)}</span>
                <span class="stat-label">Depósitos</span>
            </div>
            <div class="stat-card withdrawal">
                <span class="icon icon-minus-circle"></span>
                <span class="stat-number">${formatMoney(summary.withdrawals || 0)}</span>
                <span class="stat-label">Retiros</span>
            </div>
            <div class="stat-card bonus">
                <span class="icon icon-gift"></span>
                <span class="stat-number">${formatMoney(summary.bonuses || 0)}</span>
                <span class="stat-label">Bonificaciones</span>
            </div>
            <div class="stat-card refund">
                <span class="icon icon-undo"></span>
                <span class="stat-number">${formatMoney(summary.refunds || 0)}</span>
                <span class="stat-label">Reembolsos</span>
            </div>
            <div class="stat-card referral">
                <span class="icon icon-users"></span>
                <span class="stat-number">${formatMoney(summary.referrals || 0)}</span>
                <span class="stat-label">Referidos</span>
            </div>
            ${summary.fireRewards > 0 ? `
            <div class="stat-card bonus" style="border-color:#f97316">
                <span style="font-size:1.2rem">🔥</span>
                <span class="stat-number" style="color:#f97316">${formatMoney(summary.fireRewards || 0)}</span>
                <span class="stat-label">Fueguito</span>
            </div>` : ''}
            <div class="stat-card net-balance ${netBalanceClass}">
                <span class="icon icon-balance"></span>
                <span class="stat-number">${formatMoney(netBalance)}</span>
                <span class="stat-label">Saldo Neto</span>
            </div>
            <div class="stat-card total">
                <span class="icon icon-list"></span>
                <span class="stat-number">${summary.totalTransactions || 0}</span>
                <span class="stat-label">Total Transacciones</span>
            </div>
        `;
    }
    
    // CORREGIDO: Actualizar comisión con el total de depósitos y retiros
    window.currentDepositsTotal = summary.deposits || 0;
    window.currentWithdrawalsTotal = summary.withdrawals || 0;
    updateCommissionDisplay();
}

// CORREGIDO: Función para actualizar la visualización de comisión
// Issue #5: La comisión total se resta al saldo neto para reflejar el valor real
function updateCommissionDisplay() {
    const commissionRateInput = document.getElementById('commissionRate');
    const commissionAmountEl = document.getElementById('commissionAmount');
    const commissionBaseEl = document.getElementById('commissionBaseAmount');
    const netAfterCommissionEl = document.getElementById('netAfterCommission');
    
    if (!commissionRateInput || !commissionAmountEl) return;
    
    const rate = parseFloat(commissionRateInput.value) || 0;
    const baseAmount = window.currentDepositsTotal || 0;
    const withdrawals = window.currentWithdrawalsTotal || 0;
    const commissionAmount = baseAmount * (rate / 100);
    // Saldo neto = (depósitos - retiros) - comisión
    const netBeforeCommission = baseAmount - withdrawals;
    const netAfterCommission = netBeforeCommission - commissionAmount;
    
    commissionAmountEl.textContent = formatMoney(commissionAmount);
    if (commissionBaseEl) commissionBaseEl.textContent = formatMoney(baseAmount);
    if (netAfterCommissionEl) netAfterCommissionEl.textContent = formatMoney(netAfterCommission);

    // Issue #5: Actualizar también la tarjeta "Saldo Neto" en el dashboard
    const netBalanceEl = document.querySelector('.stat-card.net-balance .stat-number');
    if (netBalanceEl) {
        netBalanceEl.textContent = formatMoney(netAfterCommission);
        const netBalanceCard = netBalanceEl.closest('.stat-card');
        if (netBalanceCard) {
            netBalanceCard.classList.toggle('negative', netAfterCommission < 0);
        }
    }
}

function applyTransactionDateFilter() {
    transactionDateFrom = document.getElementById('dateFrom').value;
    transactionDateTo = document.getElementById('dateTo').value;
    loadTransactions();
}

function clearTransactionDateFilter() {
    transactionDateFrom = '';
    transactionDateTo = '';
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value = '';
    loadTransactions();
}

function applyTxUserFilter() {
    const input = document.getElementById('txUserFilter');
    transactionUsernameFilter = input ? input.value.trim() : '';
    loadTransactions();
}

function clearTxUserFilter() {
    transactionUsernameFilter = '';
    const input = document.getElementById('txUserFilter');
    if (input) input.value = '';
    loadTransactions();
}

// Devuelve la fecha actual en Argentina (UTC-3, sin DST) como "YYYY-MM-DD"
function getArgentinaDateStr(date) {
    // Argentina es UTC-3 todo el año (no usa horario de verano desde 2009)
    const offset = -3 * 60; // -180 minutos
    const local = new Date(date.getTime() + offset * 60 * 1000);
    return local.toISOString().split('T')[0];
}

function setTodayFilter() {
    const today = getArgentinaDateStr(new Date());
    document.getElementById('dateFrom').value = today;
    document.getElementById('dateTo').value = today;
    applyTransactionDateFilter();
}

function setYesterdayFilter() {
    const yesterday = getArgentinaDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
    document.getElementById('dateFrom').value = yesterday;
    document.getElementById('dateTo').value = yesterday;
    applyTransactionDateFilter();
}

function setWeekFilter() {
    const today = getArgentinaDateStr(new Date());
    const weekAgo = getArgentinaDateStr(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    document.getElementById('dateFrom').value = weekAgo;
    document.getElementById('dateTo').value = today;
    applyTransactionDateFilter();
}

function setMonthFilter() {
    const now = new Date();
    const today = getArgentinaDateStr(now);
    const monthAgo = getArgentinaDateStr(new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()));
    document.getElementById('dateFrom').value = monthAgo;
    document.getElementById('dateTo').value = today;
    applyTransactionDateFilter();
}

function renderTransactions(transactions) {
    const tbody = document.getElementById('transactionsTableBody');
    
    // Filtrar transacciones
    let filtered = transactions;
    if (transactionsFilter !== 'all') {
        filtered = transactions.filter(t => t.type === transactionsFilter);
    }
    
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No hay transacciones</td></tr>';
        return;
    }
    
    tbody.innerHTML = filtered.map(t => `
        <tr>
            <td>${formatDateTime(t.timestamp || t.createdAt)}</td>
            <td>${escapeHtml(t.username)}</td>
            <td><span class="type-badge ${t.type}">${getTransactionTypeLabel(t.type)}</span></td>
            <td>${formatMoney(t.amount)}</td>
            <td>${escapeHtml(t.description || '-')}</td>
            <td>${escapeHtml(t.adminUsername || '-')}</td>
        </tr>
    `).join('');
}

function getTransactionTypeLabel(type) {
    const labels = {
        deposit: 'Depósito',
        withdrawal: 'Retiro',
        bonus: 'Bonificación',
        fire_reward: '🔥 Fueguito',
        refund: 'Reembolso',
        referral_commission: '🤝 Referido'
    };
    return labels[type] || type;
}

function filterTransactions(type) {
    transactionsFilter = type;
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === type);
    });
    renderTransactions(transactionsData);
}

// ============================================
// SMS MASIVO SECTION - Password Gate
// ============================================
let smsAccessGranted = false;

function showSmsPasswordModal() {
    showModal('smsPasswordModal');
}

async function verifySmsAccessFromModal() {
    const password = document.getElementById('smsPasswordInput').value;

    if (!password) {
        showToast('Ingresa la contraseña', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/admin/verify-sms-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ password })
        });

        if (response.ok) {
            smsAccessGranted = true;
            hideModal('smsPasswordModal');
            document.getElementById('smsPasswordInput').value = '';
            document.getElementById('smsSectionContent').classList.remove('hidden');
            showToast('Acceso concedido', 'success');
        } else {
            showToast('Contraseña incorrecta', 'error');
        }
    } catch (error) {
        console.error('Error verifying SMS access:', error);
        showToast('Error al verificar acceso', 'error');
    }
}

// ============================================
// DATABASE SECTION
// ============================================
let dbAccessGranted = false;
let dbStoredPassword = ''; // Issue #2: Almacenar contraseña para reuso sin requerir re-entrada

function showDatabasePasswordModal() {
    showModal('databasePasswordModal');
}

async function verifyDatabaseAccess() {
    const password = document.getElementById('dbPassword').value;
    
    if (!password) {
        showToast('Ingresa la contraseña', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/database/verify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ dbPassword: password })
        });
        
        if (response.ok) {
            dbAccessGranted = true;
            dbStoredPassword = password; // Issue #2: guardar para reuso
            hideModal('databasePasswordModal');
            document.getElementById('databasePasswordInput').classList.add('hidden');
            document.getElementById('databaseContent').classList.remove('hidden');
            loadDatabaseUsers();
            showToast('Acceso concedido', 'success');
        } else {
            showToast('Contraseña incorrecta', 'error');
        }
    } catch (error) {
        console.error('Error verifying database access:', error);
        showToast('Error al verificar acceso', 'error');
    }
}

async function loadDatabaseUsers() {
    if (!dbAccessGranted) return;
    
    try {
        // Issue #2: Usar contraseña almacenada para evitar pérdida del valor del campo
        const password = dbStoredPassword || document.getElementById('dbPassword').value;
        if (!password) {
            console.warn('[DB] Contraseña no disponible, se requiere re-verificación');
            dbAccessGranted = false;
            switchSection('database');
            return;
        }
        const response = await fetch(`${API_URL}/api/admin/database/users`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ dbPassword: password })
        });
        
        if (!response.ok) throw new Error('Failed to load database users');
        
        const data = await response.json();
        renderDatabaseUsers(data.users || []);
    } catch (error) {
        console.error('Error loading database users:', error);
    }
}

function renderDatabaseUsers(users) {
    const tbody = document.getElementById('databaseTableBody');
    
    if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No hay usuarios en la base de datos</td></tr>';
        return;
    }
    
    tbody.innerHTML = users.map(user => `
        <tr class="${user.role !== 'user' ? 'admin-row' : ''}">
            <td>${escapeHtml(user.username)}</td>
            <td>${user.email || '-'}</td>
            <td>${user.phone || '-'}</td>
            <td><span class="role-badge ${user.role}">${getRoleLabel(user.role)}</span></td>
            <td>${formatMoney(user.balance)}</td>
            <td>${user.isActive ? 'Activo' : 'Inactivo'}</td>
            <td>${formatDate(user.lastLogin)}</td>
            <td>${formatDate(user.createdAt)}</td>
        </tr>
    `).join('');
    
    // Update count
    document.getElementById('dbTotalUsers').textContent = users.length;
    document.getElementById('dbTotalAdmins').textContent = users.filter(u => u.role !== 'user').length;
}

function getRoleLabel(role) {
    const labels = {
        user: 'Usuario',
        admin: 'Admin General',
        depositor: 'Admin Depositor',
        withdrawer: 'Admin Withdrawer'
    };
    return labels[role] || role;
}

async function exportDatabaseCSV() {
    if (!dbAccessGranted) return;
    
    try {
        // Issue #2: Usar contraseña almacenada para exportar todos los usuarios
        const password = dbStoredPassword || document.getElementById('dbPassword').value;
        if (!password) {
            console.warn('[DB] Contraseña no disponible para exportar, se requiere re-verificación');
            dbAccessGranted = false;
            switchSection('database');
            return;
        }
        const response = await fetch(`${API_URL}/api/admin/database/export/csv`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ dbPassword: password })
        });
        
        if (!response.ok) throw new Error('Failed to export database');
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `base_de_datos_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        showToast('Base de datos exportada correctamente', 'success');
    } catch (error) {
        console.error('Error exporting database:', error);
        showToast('Error al exportar base de datos', 'error');
    }
}

async function verifyDatabaseAccessFromModal() {
    const password = document.getElementById('dbPasswordInput').value;
    document.getElementById('dbPassword').value = password;
    
    try {
        const response = await fetch(`${API_URL}/api/admin/database/verify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ dbPassword: password })
        });
        
        if (response.ok) {
            dbAccessGranted = true;
            dbStoredPassword = password; // Issue #2: guardar para reuso
            hideModal('databasePasswordModal');
            document.getElementById('databasePasswordInput').classList.add('hidden');
            document.getElementById('databaseContent').classList.remove('hidden');
            loadDatabaseUsers();
            showToast('Acceso concedido', 'success');
        } else {
            showToast('Contraseña incorrecta', 'error');
        }
    } catch (error) {
        console.error('Error verifying database access:', error);
        showToast('Error al verificar acceso', 'error');
    }
}

// ============================================
// CREATE USER / ADMIN
// ============================================
function showCreateUserModal() {
    showModal('createUserModal');
}

async function handleCreateUser() {
    const username = document.getElementById('newUserUsername').value.trim();
    const password = document.getElementById('newUserPassword').value;
    const email = document.getElementById('newUserEmail').value.trim();
    const phone = document.getElementById('newUserPhone').value.trim();
    const role = document.getElementById('newUserRole').value;
    
    if (!username || !password) {
        showToast('Usuario y contraseña son requeridos', 'error');
        return;
    }
    
    if (password.length < 6) {
        showToast('La contraseña debe tener al menos 6 caracteres', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/users`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ username, password, email, phone, role })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast(data.message, 'success');
            hideModal('createUserModal');
            loadUsers();
            // Limpiar formulario
            document.getElementById('newUserUsername').value = '';
            document.getElementById('newUserPassword').value = '';
            document.getElementById('newUserEmail').value = '';
            document.getElementById('newUserPhone').value = '';
            document.getElementById('newUserRole').value = 'user';
        } else {
            showToast(data.error || 'Error al crear usuario', 'error');
        }
    } catch (error) {
        console.error('Error creating user:', error);
        showToast('Error al crear usuario', 'error');
    }
}

// ============================================
// COMMANDS MANAGEMENT
// ============================================
let commandsData = [];

async function loadCommands() {
    try {
        const response = await fetch(`${API_URL}/api/admin/commands`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load commands');
        
        const data = await response.json();
        commandsData = data.commands || [];
        // CORREGIDO: Actualizar availableCommands para las sugerencias
        availableCommands = commandsData.filter(cmd => cmd.isActive !== false);
        renderCommands(commandsData);
        
        // Cargar CBU
        loadCBUConfig();
    } catch (error) {
        console.error('Error loading commands:', error);
    }
}

function renderCommands(commands) {
    const container = document.getElementById('commandsList');
    
    if (!commands.length) {
        container.innerHTML = '<div class="empty-state">No hay comandos personalizados</div>';
        return;
    }
    
    container.innerHTML = commands.map(cmd => `
        <div class="command-card">
            <div class="command-info">
                <code class="command-name">${escapeHtml(cmd.name)}${cmd.isSystem ? ' 🔒' : ''}</code>
                <p class="command-desc">${escapeHtml(cmd.description || 'Sin descripción')}</p>
                <p class="command-response">${escapeHtml(cmd.response || 'Sin respuesta')}</p>
            </div>
            <div class="command-actions">
                <button class="btn-small" onclick="editCommand('${cmd.name}')">
                    <span class="icon icon-edit"></span>
                </button>
                ${cmd.isSystem ? '' : `<button class="btn-small btn-danger" onclick="deleteCommand('${cmd.name}')">
                    <span class="icon icon-trash"></span>
                </button>`}
            </div>
        </div>
    `).join('');
}

async function loadCBUConfig() {
    try {
        const response = await fetch(`${API_URL}/api/admin/cbu`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            document.getElementById('cbuBank').value = data.bank || '';
            document.getElementById('cbuTitular').value = data.titular || '';
            document.getElementById('cbuNumber').value = data.number || '';
            document.getElementById('cbuAlias').value = data.alias || '';
        }
    } catch (error) {
        console.error('Error loading CBU:', error);
    }
    
    // Cargar también la URL del Canal Informativo
    loadCanalUrlConfig();
}

async function saveCBUConfig() {
    const bank = document.getElementById('cbuBank').value.trim();
    const titular = document.getElementById('cbuTitular').value.trim();
    const number = document.getElementById('cbuNumber').value.trim();
    const alias = document.getElementById('cbuAlias').value.trim();
    
    if (!number) {
        showToast('El CBU es requerido', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/cbu`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ bank, titular, number, alias })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast('CBU guardado correctamente', 'success');
        } else {
            showToast(data.error || 'Error al guardar CBU', 'error');
        }
    } catch (error) {
        console.error('Error saving CBU:', error);
        showToast('Error al guardar CBU', 'error');
    }
}

async function loadCanalUrlConfig() {
    try {
        const response = await fetch(`${API_URL}/api/admin/config`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (response.ok) {
            const data = await response.json();
            const urlInput = document.getElementById('canalInformativoUrl');
            if (urlInput) {
                urlInput.value = data.canalInformativoUrl || '';
            }
        }
    } catch (error) {
        console.error('Error loading canal URL:', error);
    }
}

async function saveCanalUrl() {
    const urlInput = document.getElementById('canalInformativoUrl');
    const url = urlInput ? urlInput.value.trim() : '';
    
    try {
        const response = await fetch(`${API_URL}/api/admin/canal-url`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ url })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast('URL del Canal Informativo guardada correctamente', 'success');
        } else {
            showToast(data.error || data.message || 'Error al guardar URL', 'error');
        }
    } catch (error) {
        console.error('Error saving canal URL:', error);
        showToast('Error al guardar URL', 'error');
    }
}

function showCreateCommandModal() {
    document.getElementById('commandName').value = '/';
    document.getElementById('commandDesc').value = '';
    document.getElementById('commandResponse').value = '';
    document.getElementById('commandModalTitle').textContent = 'Nuevo Comando';
    document.getElementById('commandModalAction').onclick = handleCreateCommand;
    showModal('commandModal');
}

function editCommand(name) {
    const cmd = commandsData.find(c => c.name === name);
    if (!cmd) return;
    
    document.getElementById('commandName').value = cmd.name;
    document.getElementById('commandDesc').value = cmd.description || '';
    document.getElementById('commandResponse').value = cmd.response || '';
    document.getElementById('commandModalTitle').textContent = 'Editar Comando';
    document.getElementById('commandModalAction').onclick = handleUpdateCommand;
    showModal('commandModal');
}

async function handleCreateCommand() {
    const name = document.getElementById('commandName').value.trim();
    const description = document.getElementById('commandDesc').value.trim();
    const response = document.getElementById('commandResponse').value.trim();
    
    if (!name || !name.startsWith('/')) {
        showToast('El comando debe empezar con /', 'error');
        return;
    }
    
    try {
        const res = await fetch(`${API_URL}/api/admin/commands`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ name, description, response })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            showToast('Comando creado correctamente', 'success');
            hideModal('commandModal');
            loadCommands();
        } else {
            showToast(data.error || 'Error al crear comando', 'error');
        }
    } catch (error) {
        console.error('Error creating command:', error);
        showToast('Error al crear comando', 'error');
    }
}

async function handleUpdateCommand() {
    await handleCreateCommand(); // El endpoint es el mismo para crear/actualizar
}

async function deleteCommand(name) {
    if (!confirm(`¿Estás seguro de eliminar el comando ${name}?`)) return;
    
    try {
        const response = await fetch(`${API_URL}/api/admin/commands/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            showToast('Comando eliminado correctamente', 'success');
            loadCommands();
        } else {
            const data = await response.json();
            showToast(data.error || 'Error al eliminar comando', 'error');
        }
    } catch (error) {
        console.error('Error deleting command:', error);
        showToast('Error al eliminar comando', 'error');
    }
}

// Global functions for inline handlers
window.viewUser = async function(userId) {
    const body = document.getElementById('userDetailBody');
    if (body) body.innerHTML = '<p style="color:#888">Cargando...</p>';
    showModal('userDetailModal');
    try {
        const res = await fetch(`${API_URL}/api/users/${encodeURIComponent(userId)}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error al obtener usuario');
        const u = data.user || {};
        const blocked = u.isBlocked
            ? `<span style="color:#dc3545;font-weight:700">SÍ</span>${u.blockReason ? ` — <em style="color:#aaa">${escapeHtml(u.blockReason)}</em>` : ''}`
            : '<span style="color:#16a34a">No</span>';
        const lastLogin = u.lastLogin ? formatDate(u.lastLogin) : 'Nunca';
        const created = u.createdAt ? formatDate(u.createdAt) : '-';
        if (body) {
            body.innerHTML = `
                <div style="display:grid;gap:.6rem;font-size:.92rem;line-height:1.4">
                    <div><strong>Username:</strong> ${escapeHtml(u.username || '-')}</div>
                    <div><strong>Email:</strong> ${escapeHtml(u.email || '-')}</div>
                    <div><strong>Teléfono:</strong> ${escapeHtml(u.phone || '-')}</div>
                    <div><strong>Rol:</strong> <span class="role-badge ${escapeHtml(u.role || 'user')}">${escapeHtml(getRoleLabel(u.role) || u.role || '-')}</span></div>
                    <div><strong>Balance:</strong> ${formatMoney(u.balance || 0)}</div>
                    <div><strong>N° de cuenta:</strong> ${escapeHtml(u.accountNumber || u.accountId || '-')}</div>
                    <div><strong>Estado:</strong> ${escapeHtml(u.status || '-')}</div>
                    <div><strong>Bloqueado:</strong> ${blocked}</div>
                    <div><strong>Origen:</strong> ${escapeHtml(u.source || 'local')}</div>
                    <div><strong>Debe cambiar contraseña:</strong> ${u.mustChangePassword ? 'Sí' : 'No'}</div>
                    <div><strong>Último login:</strong> ${escapeHtml(lastLogin)}</div>
                    <div><strong>Fecha creación:</strong> ${escapeHtml(created)}</div>
                    <div><strong>JUGAYGANA ID:</strong> ${escapeHtml(u.jugayganaUserId || '-')}</div>
                    <div><strong>Tokens FCM:</strong> ${(u.fcmTokens && u.fcmTokens.length) || 0}</div>
                </div>
            `;
        }
    } catch (e) {
        if (body) body.innerHTML = `<p style="color:#f87171">❌ ${escapeHtml(e.message || 'Error')}</p>`;
    }
};

window.chatUser = function(userId) {
    selectConversation(userId, 'Usuario');
    switchSection('chats');
};

window.editCommand = editCommand;
window.deleteCommand = deleteCommand;

// ============================================
// PWA - INSTALACIÓN DE APP EN ANDROID
// ============================================

// Detectar si la app ya está instalada
function checkAppInstalled() {
    if (window.matchMedia('(display-mode: standalone)').matches || 
        window.navigator.standalone === true) {
        isAppInstalled = true;
        console.log('✅ App ya instalada (standalone mode)');
        return true;
    }
    return false;
}

// Inicializar PWA - Escuchar evento beforeinstallprompt
function initPWA() {
    console.log('🚀 Inicializando PWA...');
    
    // Verificar si ya está instalada
    if (checkAppInstalled()) {
        hideInstallButton();
        return;
    }
    
    // Escuchar evento beforeinstallprompt
    window.addEventListener('beforeinstallprompt', (e) => {
        console.log('📱 beforeinstallprompt event recibido');
        // Prevenir que el navegador muestre el prompt automático
        e.preventDefault();
        // Guardar el evento para usarlo después
        deferredInstallPrompt = e;
        // Mostrar el botón de instalación
        showInstallButton();
    });
    
    // Escuchar cuando la app es instalada
    window.addEventListener('appinstalled', (e) => {
        console.log('✅ App instalada exitosamente');
        isAppInstalled = true;
        hideInstallButton();
        deferredInstallPrompt = null;
        showToast('✅ App instalada correctamente', 'success');
    });
    
    // Verificar periódicamente si el botón debe mostrarse
    setTimeout(() => {
        if (!isAppInstalled && deferredInstallPrompt) {
            showInstallButton();
        }
    }, 2000);
}

// Mostrar botón de instalación
function showInstallButton() {
    const installBtn = document.getElementById('installAppBtn');
    if (installBtn && !isAppInstalled) {
        installBtn.classList.remove('hidden');
        console.log('📱 Botón de instalación visible');
    }
}

// Ocultar botón de instalación
function hideInstallButton() {
    const installBtn = document.getElementById('installAppBtn');
    if (installBtn) {
        installBtn.classList.add('hidden');
    }
}

// Manejar click en botón de instalación
async function handleInstallApp() {
    console.log('📱 Click en botón de instalación');
    
    if (!deferredInstallPrompt) {
        console.log('⚠️ No hay prompt de instalación disponible');
        showToast('La instalación no está disponible en este momento', 'info');
        return;
    }
    
    // Mostrar el prompt de instalación
    deferredInstallPrompt.prompt();
    
    // Esperar la respuesta del usuario
    const { outcome } = await deferredInstallPrompt.userChoice;
    console.log('📱 Resultado de instalación:', outcome);
    
    if (outcome === 'accepted') {
        console.log('✅ Usuario aceptó instalar');
        isAppInstalled = true;
        hideInstallButton();
    } else {
        console.log('❌ Usuario rechazó instalar');
    }
    
    // Limpiar el prompt guardado
    deferredInstallPrompt = null;
}

// ============================================
// NOTIFICACIONES PUSH - SERVICE WORKER
// ============================================

// Registrar Service Worker para notificaciones push
async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        console.log('⚠️ Service Worker no soportado');
        return false;
    }
    
    try {
        const registration = await navigator.serviceWorker.register('/admin-sw.js', { scope: '/adminprivado2026/' });
        console.log('✅ Service Worker registrado:', registration.scope);
        
        // Escuchar mensajes del service worker
        navigator.serviceWorker.addEventListener('message', (event) => {
            console.log('📨 Mensaje del SW:', event.data);
            if (event.data.type === 'NEW_MESSAGE') {
                // Mostrar notificación local si la app está abierta
                showBrowserNotification(
                    event.data.title,
                    event.data.body,
                    event.data.icon
                );
            }
        });
        
        return registration;
    } catch (error) {
        console.error('❌ Error registrando Service Worker:', error);
        return false;
    }
}

// Solicitar permiso para notificaciones
async function requestPushPermission() {
    if (!('Notification' in window)) {
        console.log('⚠️ Notificaciones no soportadas');
        return false;
    }
    
    const permission = await Notification.requestPermission();
    console.log('🔔 Permiso de notificaciones:', permission);
    
    if (permission === 'granted') {
        await registerServiceWorker();
        return true;
    }
    return false;
}

// Enviar notificación push cuando el admin envía mensaje
async function sendPushNotification(userId, message) {
    try {
        const response = await fetch(`${API_URL}/api/admin/send-notification`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: userId,
                title: '💬 Nuevo mensaje del soporte',
                body: message.type === 'image' ? '📸 Imagen' : message.content.substring(0, 100),
                icon: '/icons/icon-192x192.png',
                badge: '/icons/icon-72x72.png',
                tag: `chat-${userId}`,
                requireInteraction: false,
                data: {
                    url: '/',
                    userId: userId
                }
            })
        });
        
        if (response.ok) {
            console.log('✅ Notificación push enviada');
        }
    } catch (error) {
        console.error('❌ Error enviando notificación push:', error);
    }
}

// ============================================
// CHAT ULTRA-RÁPIDO - OPTIMIZACIONES
// ============================================

// Precargar mensajes de conversaciones frecuentes
async function prefetchFrequentConversations() {
    const frequentUsers = conversations.slice(0, 5); // Top 5 conversaciones
    
    for (const conv of frequentUsers) {
        if (!messageCache.has(conv.userId)) {
            fetch(`${API_URL}/api/messages/${conv.userId}?limit=50`, {
                headers: { 'Authorization': `Bearer ${currentToken}` }
            })
            .then(r => r.json())
            .then(data => {
                if (data.messages) {
                    messageCache.set(conv.userId, data.messages);
                    console.log('✅ Prefetch completado para:', conv.username);
                }
            })
            .catch(() => {});
        }
    }
}

// Renderizado ultra-rápido de mensajes
function renderMessagesUltraFast(messages) {
    // Usar DocumentFragment para minimizar reflows
    const fragment = document.createDocumentFragment();
    
    messages.forEach(msg => {
        if (msg.id && processedMessageIds.has(msg.id)) return;
        
        const msgDiv = createMessageElement(msg);
        fragment.appendChild(msgDiv);
        
        if (msg.id) {
            processedMessageIds.add(msg.id);
        }
    });
    
    // Limpiar y agregar todo de una vez
    elements.chatMessages.innerHTML = '';
    elements.chatMessages.appendChild(fragment);
    
    // Scroll inmediato sin animación para máxima velocidad
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

// Crear elemento de mensaje optimizado
function createMessageElement(message) {
    // Fix #3: Mensajes de sistema (ej. cierre de chat) con estilo propio
    if (message.type === 'system') {
        const div = document.createElement('div');
        div.className = 'message system';
        div.dataset.messageid = message.id || '';
        div.innerHTML = `<span class="icon icon-lock"></span> <span>${escapeHtml(message.content)}</span>`;
        return div;
    }
    
    const isOutgoing = getMessageType(message) === 'outgoing';
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}`;
    msgDiv.dataset.messageid = message.id;
    
    const time = formatDateTime(message.timestamp || new Date());
    const content = formatMessageContent(message);
    
    msgDiv.innerHTML = `
        <div class="message-header">
            <span class="icon icon-user"></span>
            <span>${escapeHtml(message.senderUsername || 'Usuario')}</span>
        </div>
        <div class="message-content">${content}</div>
        <div class="message-time">${time}</div>
    `;

    const lightboxImg = msgDiv.querySelector('[data-lightbox-src]');
    if (lightboxImg) {
        const src = lightboxImg.dataset.lightboxSrc;
        lightboxImg.addEventListener('click', function() {
            openLightbox(src);
        });
    }
    
    return msgDiv;
}

// Inicializar PWA al cargar
document.addEventListener('DOMContentLoaded', () => {
    initPWA();
    
    // Configurar botón de instalación
    const installBtn = document.getElementById('installAppBtn');
    if (installBtn) {
        installBtn.addEventListener('click', handleInstallApp);
    }
});

// Exponer funciones globales
window.handleInstallApp = handleInstallApp;
window.requestPushPermission = requestPushPermission;
// ============================================
// PANEL DE NOTIFICACIONES PUSH
// Ruta: /adminprivado2026/ → nav item "Notificaciones"
// ============================================

let notifCurrentPage = 1;

async function loadNotificationsPanel() {
    const filter = document.getElementById('notifUserFilter')?.value || 'all';
    await Promise.all([
        loadNotifStats(),
        loadNotifUsers(1, filter)
    ]);
}

async function loadNotifStats() {
    try {
        const res = await fetch(`${API_URL}/api/notifications/users-status?page=1&limit=1&filter=all`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await res.json();
        if (!data.success) return;
        const s = data.stats;
        document.getElementById('notifTotalUsers').textContent = s.totalUsers;
        document.getElementById('notifWithToken').textContent = s.usersWithToken;
        document.getElementById('notifWithoutToken').textContent = s.usersWithoutToken;
        document.getElementById('notifCoverage').textContent = s.coverage + '%';
    } catch (e) {
        console.error('[Notif Panel] Error cargando stats:', e);
    }
}

async function loadNotifUsers(page = 1, filter = 'all') {
    notifCurrentPage = page;
    const limit = 50;
    const listEl = document.getElementById('notifUsersList');
    const pagEl = document.getElementById('notifPagination');
    if (listEl) listEl.innerHTML = '<p style="color:#888;text-align:center">Cargando...</p>';

    try {
        const res = await fetch(`${API_URL}/api/notifications/users-status?page=${page}&limit=${limit}&filter=${filter}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await res.json();
        if (!data.success) { if (listEl) listEl.innerHTML = '<p style="color:#f00">Error al cargar</p>'; return; }

        if (!data.users || data.users.length === 0) {
            if (listEl) listEl.innerHTML = '<p style="color:#888;text-align:center">No hay usuarios con este filtro</p>';
            if (pagEl) pagEl.innerHTML = '';
            return;
        }

        const rows = data.users.map(u => `
            <tr>
                <td style="padding:.5rem .75rem">${escapeHtml(u.username)}</td>
                <td style="padding:.5rem .75rem;text-align:center">
                    ${u.hasToken
                        ? '<span style="color:#00ff88;font-size:.85rem">📱 App instalada</span>'
                        : '<span style="color:#888;font-size:.85rem">📵 Sin app</span>'}
                </td>
                <td style="padding:.5rem .75rem;color:#888;font-size:.8rem">
                    ${u.tokenUpdatedAt ? new Date(u.tokenUpdatedAt).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—'}
                </td>
                <td style="padding:.5rem .75rem;color:#888;font-size:.8rem">
                    ${u.lastLogin ? new Date(u.lastLogin).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—'}
                </td>
            </tr>
        `).join('');

        if (listEl) listEl.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:.9rem">
                <thead>
                    <tr style="border-bottom:1px solid rgba(255,255,255,.1);color:#aaa;font-size:.8rem">
                        <th style="padding:.5rem .75rem;text-align:left">Usuario</th>
                        <th style="padding:.5rem .75rem;text-align:center">Estado App</th>
                        <th style="padding:.5rem .75rem;text-align:left">Token actualizado</th>
                        <th style="padding:.5rem .75rem;text-align:left">Último login</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;

        // Pagination: show prev, up to 5 pages around current, and next
        if (pagEl) {
            const totalPages = data.pagination.pages;
            let btns = '';
            if (page > 1) btns += `<button class="btn btn-sm btn-secondary" onclick="loadNotifUsers(${page - 1}, '${filter}')">◀ Ant</button>`;
            const startPage = Math.max(1, page - 2);
            const endPage = Math.min(totalPages, page + 2);
            if (startPage > 1) btns += `<button class="btn btn-sm btn-secondary" onclick="loadNotifUsers(1, '${filter}')">1</button><span style="color:#888;padding:.25rem .25rem">…</span>`;
            for (let i = startPage; i <= endPage; i++) {
                btns += `<button class="btn btn-sm ${i === page ? 'btn-primary' : 'btn-secondary'}" onclick="loadNotifUsers(${i}, '${filter}')">${i}</button>`;
            }
            if (endPage < totalPages) btns += `<span style="color:#888;padding:.25rem .25rem">…</span><button class="btn btn-sm btn-secondary" onclick="loadNotifUsers(${totalPages}, '${filter}')">${totalPages}</button>`;
            if (page < totalPages) btns += `<button class="btn btn-sm btn-secondary" onclick="loadNotifUsers(${page + 1}, '${filter}')">Sig ▶</button>`;
            pagEl.innerHTML = btns;
        }
    } catch (e) {
        console.error('[Notif Panel] Error cargando usuarios:', e);
        if (listEl) listEl.innerHTML = '<p style="color:#f00;text-align:center">Error al cargar usuarios</p>';
    }
}

async function sendBatchNotification(batchOffset) {
    const title = document.getElementById('notifTitle')?.value?.trim();
    const body = document.getElementById('notifBody')?.value?.trim();
    const segment = document.getElementById('notifSegment')?.value || 'all';
    const batchSize = parseInt(document.getElementById('notifBatchSize')?.value || '100');
    const offset = (batchOffset !== undefined) ? parseInt(batchOffset) : (parseInt(document.getElementById('notifBatchOffset')?.value || '0') || 0);

    if (!title || !body) {
        showToast('❌ El título y el mensaje son obligatorios', 'error');
        return;
    }

    let usernames = null;
    if (segment === 'specific') {
        const raw = document.getElementById('notifUsernames')?.value || '';
        usernames = raw.split(/[\n,]+/).map(u => u.trim()).filter(Boolean);
        if (usernames.length === 0) {
            showToast('❌ Ingresá al menos un username en "Usuarios específicos"', 'error');
            return;
        }
    }

    const sendBtn = document.getElementById('notifSendBtn');
    const nextBtn = document.getElementById('notifNextBatchBtn');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '⏳ Enviando...'; }
    if (nextBtn) nextBtn.disabled = true;

    const resultEl = document.getElementById('notifResult');
    const resultContent = document.getElementById('notifResultContent');
    if (resultEl) resultEl.style.display = 'none';

    try {
        const res = await fetch(`${API_URL}/api/notifications/send-batch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ title, body, batchSize, segment, batchOffset: offset, usernames })
        });
        const data = await res.json();

        if (resultEl) resultEl.style.display = 'block';
        if (resultContent) {
            if (data.success) {
                const pct = data.totalUsers > 0 ? Math.round((data.successCount / data.totalUsers) * 100) : 0;
                const sentNames = data.sentUsernames && data.sentUsernames.length > 0
                    ? `<details style="margin-top:.5rem"><summary style="cursor:pointer;color:#aaa;font-size:.85rem">Ver usuarios enviados (${data.sentUsernames.length}${data.sentUsernames.length < data.totalUsers ? '+' : ''})</summary><div style="margin-top:.5rem;max-height:160px;overflow-y:auto;font-size:.8rem;color:#ccc">${data.sentUsernames.map(u => escapeHtml(u)).join(', ')}</div></details>` : '';
                resultContent.innerHTML = `
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1rem;margin-bottom:1rem">
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#00ff88">${data.successCount}</div><div style="color:#aaa;font-size:.8rem">Aceptados por FCM</div></div>
                        <div style="text-align:center" id="batchConfirmedCell"><div style="font-size:1.5rem;font-weight:700;color:#22d3ee" id="batchConfirmedNum">0</div><div style="color:#aaa;font-size:.8rem">Confirmados (entregados)</div></div>
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#f87171">${data.failureCount}</div><div style="color:#aaa;font-size:.8rem">Fallidos</div></div>
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#fbbf24">${data.cleanedTokens}</div><div style="color:#aaa;font-size:.8rem">Tokens limpiados</div></div>
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#6366f1">${data.totalUsers}</div><div style="color:#aaa;font-size:.8rem">En este lote</div></div>
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700">${pct}%</div><div style="color:#aaa;font-size:.8rem">Tasa FCM</div></div>
                    </div>
                    <div style="font-size:.82rem;color:#aaa;margin-bottom:.5rem">Total del segmento: <strong>${data.totalSegmentUsers}</strong> | Enviados hasta ahora: <strong>${data.nextOffset}</strong> | Faltan: <strong style="color:${data.remaining > 0 ? '#fbbf24' : '#00ff88'}">${data.remaining}</strong></div>
                    <div id="batchDeliveryStatus" style="font-size:.78rem;color:#aaa;margin-bottom:.5rem;font-style:italic">⏳ Esperando confirmaciones de entrega del cliente…</div>
                    ${sentNames}
                    ${data.failedTokens && data.failedTokens.length > 0 ? `
                    <details style="margin-top:.5rem">
                        <summary style="cursor:pointer;color:#aaa;font-size:.85rem">Ver tokens fallidos (${data.failedTokens.length})</summary>
                        <div style="margin-top:.5rem;max-height:200px;overflow-y:auto">
                        ${data.failedTokens.map(f => `<div style="font-size:.8rem;padding:.25rem 0;border-bottom:1px solid rgba(255,255,255,.05)"><strong>${escapeHtml(f.username)}</strong> — ${escapeHtml(f.error || '')} ${f.cleaned ? '<span style="color:#fbbf24">(token limpiado)</span>' : ''}</div>`).join('')}
                        </div>
                    </details>` : ''}
                `;
                showToast(`✅ FCM aceptó ${data.successCount} envíos. Esperando confirmaciones reales...`, 'success');

                // ============================================
                // POLLING DE CONFIRMACIONES DE ENTREGA REAL
                // ============================================
                // FCM aceptar != entregado. El SW del cliente confirma cuando
                // realmente recibe el push. Polleamos batch-status durante 30s
                // y mostramos el conteo real. Pasados 30s sin confirmación, los
                // usuarios "Aceptados pero no Confirmados" son sospechosos
                // (token muerto, app desinstalada, datos borrados).
                if (data.batchId && data.successCount > 0) {
                    const _batchIdLocal = data.batchId;
                    let _polls = 0;
                    const _maxPolls = 15; // 15 × 2s = 30s
                    const _pollInterval = setInterval(async function () {
                        _polls++;
                        try {
                            const stRes = await fetch(`${API_URL}/api/notifications/batch-status/${encodeURIComponent(_batchIdLocal)}`, {
                                headers: { 'Authorization': `Bearer ${currentToken}` }
                            });
                            if (!stRes.ok) {
                                clearInterval(_pollInterval);
                                return;
                            }
                            const st = await stRes.json();
                            const numEl = document.getElementById('batchConfirmedNum');
                            const statusEl = document.getElementById('batchDeliveryStatus');
                            if (numEl) numEl.textContent = String(st.confirmed);
                            if (statusEl) {
                                const pendingNow = Math.max(0, st.sent - st.confirmed);
                                if (_polls >= _maxPolls) {
                                    statusEl.innerHTML = pendingNow === 0
                                        ? `✅ Todos los envíos confirmados (${st.confirmed}/${st.sent}).`
                                        : `⚠️ ${pendingNow} de ${st.sent} sin confirmación tras 30s — probablemente con token muerto (app desinstalada o datos borrados). FCM los aceptó pero nunca llegaron al dispositivo.`;
                                    statusEl.style.color = pendingNow === 0 ? '#22d3ee' : '#fbbf24';
                                    statusEl.style.fontStyle = 'normal';
                                    clearInterval(_pollInterval);
                                } else {
                                    statusEl.innerHTML = `⏳ ${st.confirmed}/${st.sent} confirmados (poll ${_polls}/${_maxPolls})…`;
                                }
                            }
                            if (st.confirmed >= st.sent && _polls >= 2) {
                                if (statusEl) {
                                    statusEl.innerHTML = `✅ Todos los envíos confirmados (${st.confirmed}/${st.sent}).`;
                                    statusEl.style.color = '#22d3ee';
                                    statusEl.style.fontStyle = 'normal';
                                }
                                clearInterval(_pollInterval);
                            }
                        } catch (e) {
                            console.warn('[Notif Panel] poll batch-status error:', e && e.message);
                        }
                    }, 2000);
                }

                // Update next-batch state
                const statusEl = document.getElementById('notifBatchStatus');
                if (statusEl) {
                    if (data.remaining > 0) {
                        statusEl.style.display = 'block';
                        statusEl.innerHTML = `📊 Enviados: ${data.nextOffset} / ${data.totalSegmentUsers} del segmento | Faltan: <strong>${data.remaining}</strong>`;
                        if (nextBtn) { nextBtn.style.display = ''; nextBtn.dataset.nextOffset = data.nextOffset; }
                    } else {
                        statusEl.style.display = 'block';
                        statusEl.innerHTML = `✅ Segmento completo: ${data.nextOffset} / ${data.totalSegmentUsers} enviados`;
                        if (nextBtn) nextBtn.style.display = 'none';
                    }
                }
                if (document.getElementById('notifBatchOffset')) {
                    document.getElementById('notifBatchOffset').value = data.nextOffset;
                }

                // Reload stats and token list after sending (tokens may have been cleaned)
                loadNotificationsPanel();
            } else {
                resultContent.innerHTML = `<p style="color:#f87171">❌ Error: ${escapeHtml(data.error || 'Error desconocido')}</p>`;
                showToast('❌ Error al enviar notificaciones', 'error');
            }
        }
    } catch (e) {
        showToast('❌ Error de conexión al enviar notificaciones', 'error');
        console.error('[Notif Panel] Error enviando:', e);
    } finally {
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '🚀 Enviar lote'; }
        if (nextBtn) nextBtn.disabled = false;
    }
}

function sendNextBatch() {
    const nextBtn = document.getElementById('notifNextBatchBtn');
    const nextOffset = parseInt(nextBtn?.dataset.nextOffset || '0');
    sendBatchNotification(nextOffset);
}

function resetNotifBatch() {
    const offsetInput = document.getElementById('notifBatchOffset');
    if (offsetInput) offsetInput.value = '0';
    const nextBtn = document.getElementById('notifNextBatchBtn');
    if (nextBtn) { nextBtn.style.display = 'none'; delete nextBtn.dataset.nextOffset; }
    const statusEl = document.getElementById('notifBatchStatus');
    if (statusEl) statusEl.style.display = 'none';
    showToast('Lote reiniciado desde el principio', 'info');
}

function updateNotifNextBatchVisibility() {
    const mode = document.querySelector('input[name="notifMode"]:checked')?.value || 'batch';
    if (mode === 'all_app') return; // handled by updateNotifModeUI
    const segment = document.getElementById('notifSegment')?.value || 'all';
    const offsetDiv = document.getElementById('notifOffsetDiv');
    if (offsetDiv) offsetDiv.style.display = (segment !== 'specific') ? 'block' : 'none';
}

function updateNotifModeUI() {
    const mode = document.querySelector('input[name="notifMode"]:checked')?.value || 'batch';
    const batchControls = document.getElementById('notifBatchControls');
    const allAppControls = document.getElementById('notifAllAppControls');
    const modeInfo = document.getElementById('notifModeInfo');

    if (mode === 'all_app') {
        if (batchControls) batchControls.style.display = 'none';
        if (allAppControls) allAppControls.style.display = '';
        if (modeInfo) {
            modeInfo.style.display = 'block';
            modeInfo.textContent = '📱 Se enviará a todos los usuarios que tengan la app instalada, automáticamente por lotes de 200.';
        }
    } else {
        if (batchControls) batchControls.style.display = 'flex';
        if (allAppControls) allAppControls.style.display = 'none';
        if (modeInfo) modeInfo.style.display = 'none';
        updateNotifNextBatchVisibility();
    }
}

// Tamaño de lote del envío masivo "Todos con app".
// 100 es conservador (menor riesgo de timeout/504 en el ALB) y match con el modo lote manual.
const NOTIF_ALL_APP_BATCH_SIZE = 100;
// Pausa entre lotes: aliviana presión sobre Mongo, FCM y el ALB.
const NOTIF_ALL_APP_BATCH_DELAY_MS = 800;

function _notifSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Envía notificación a TODOS los usuarios con app, en lotes secuenciales.
 *
 * Reglas críticas:
 * - NO reintenta automáticamente lotes fallidos. Reintentar un lote que ya
 *   envió parcialmente duplicaría mensajes a usuarios que ya recibieron, lo
 *   cual es muy molesto. Si un lote falla, se detiene todo y se muestra al
 *   admin exactamente hasta dónde se llegó, dándole la opción manual de
 *   reanudar desde el siguiente lote (no se duplica) o reintentar el lote
 *   fallido (con confirm explícito y aviso de duplicación).
 * - Avanza usando data.nextOffset (que ya descuenta tokens limpiados gracias
 *   al fix de notificationRoutes.js). Eso garantiza que ningún usuario se
 *   saltee aunque haya cleanup de tokens muertos en el medio.
 * - Limpieza de tokens muertos la hace el endpoint /send-batch en backend.
 *
 * @param {number} startOffset - offset desde donde arrancar (0 por default,
 *   o un valor mayor si el admin pidió reanudar tras una falla previa).
 */
async function sendAllWithApp(startOffset = 0) {
    const title = document.getElementById('notifTitle')?.value?.trim();
    const body = document.getElementById('notifBody')?.value?.trim();
    if (!title || !body) {
        showToast('❌ El título y el mensaje son obligatorios', 'error');
        return;
    }

    // Confirmación al iniciar desde 0 (operación que puede tardar varios minutos)
    if (startOffset === 0) {
        if (!confirm('Vas a enviar a TODOS los usuarios con app instalada. Puede tardar varios minutos según la cantidad de usuarios. ¿Continuar?')) return;
    }

    const sendBtn = document.getElementById('notifSendAllBtn');
    const progressEl = document.getElementById('notifAllAppProgress');
    const resultEl = document.getElementById('notifResult');
    const resultContent = document.getElementById('notifResultContent');

    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '⏳ Enviando...'; }
    if (progressEl) {
        progressEl.style.display = 'block';
        progressEl.textContent = startOffset === 0
            ? '🔄 Iniciando envío masivo...'
            : `🔄 Reanudando desde el usuario N° ${startOffset}...`;
    }

    let offset = startOffset;
    let totalSent = 0, totalFailed = 0, totalCleaned = 0, totalSegment = 0;
    let batchNum = 0;
    let failed = false, failedReason = '', failedAtOffset = null;
    const startedAt = Date.now();

    try {
        while (true) {
            batchNum++;
            const lblOffset = offset;
            if (progressEl) {
                progressEl.textContent = `🔄 Lote ${batchNum} (desde usuario N° ${lblOffset})...`;
            }

            // 1) Llamada al backend con manejo robusto de errores
            let response;
            try {
                response = await fetch(`${API_URL}/api/notifications/send-batch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
                    body: JSON.stringify({
                        title, body,
                        batchSize: NOTIF_ALL_APP_BATCH_SIZE,
                        segment: 'all',
                        batchOffset: offset
                    })
                });
            } catch (networkErr) {
                // Error de red: la request puede haber llegado al server o no, no podemos saberlo.
                // No reintentamos para no duplicar.
                failed = true;
                failedAtOffset = offset;
                failedReason = `Error de red: ${networkErr.message || networkErr}`;
                console.error('[Notif Panel] Network error en lote', batchNum, networkErr);
                break;
            }

            if (!response.ok) {
                failed = true;
                failedAtOffset = offset;
                let errMsg = `HTTP ${response.status}`;
                try {
                    const errData = await response.json();
                    if (errData && errData.error) errMsg += ` — ${errData.error}`;
                } catch (_) { /* respuesta no es JSON parseable */ }
                failedReason = errMsg;
                break;
            }

            let data;
            try {
                data = await response.json();
            } catch (jsonErr) {
                failed = true;
                failedAtOffset = offset;
                failedReason = 'Respuesta del servidor inválida (no es JSON)';
                break;
            }

            if (!data.success) {
                failed = true;
                failedAtOffset = offset;
                failedReason = data.error || 'El servidor reportó fallo sin detalle';
                break;
            }

            // 2) Lote OK: contabilizar resultados
            totalSent += data.successCount || 0;
            totalFailed += data.failureCount || 0;
            totalCleaned += data.cleanedTokens || 0;
            totalSegment = data.totalSegmentUsers || totalSegment;

            if (progressEl) {
                progressEl.textContent =
                    `✅ Lote ${batchNum} OK — Enviados acumulados: ${totalSent} | ` +
                    `Tokens limpiados: ${totalCleaned} | Faltan: ${data.remaining}`;
            }

            // 3) Verificar fin del segmento
            if (!data.remaining || data.remaining <= 0) {
                break;
            }

            // 4) Avanzar al próximo offset confirmado por el server (ya descuenta limpiados)
            offset = data.nextOffset;

            // 5) Pausa entre lotes para no saturar
            await _notifSleep(NOTIF_ALL_APP_BATCH_DELAY_MS);
        }
    } catch (e) {
        failed = true;
        failedReason = `Error inesperado: ${e.message || e}`;
        console.error('[Notif Panel] Error inesperado en sendAllWithApp:', e);
    } finally {
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '📤 Enviar a TODOS con app'; }
    }

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

    // 6) Render del resultado final
    if (resultEl) resultEl.style.display = 'block';
    if (resultContent) {
        const headerHtml = failed
            ? `<div style="margin-bottom:.75rem;padding:.7rem 1rem;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.4);border-radius:8px;color:#fca5a5">
                 ⚠️ <strong>Envío detenido en el lote ${batchNum}</strong> (offset ${failedAtOffset}) tras ${elapsedSec}s.<br>
                 <span style="font-size:.85rem">Motivo: ${escapeHtml(failedReason)}</span>
               </div>`
            : `<div style="margin-bottom:.75rem;padding:.7rem 1rem;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.4);border-radius:8px;color:#86efac">
                 ✅ <strong>Envío completo</strong> en ${batchNum} lotes (${elapsedSec}s)
               </div>`;

        const statsHtml = `
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1rem">
                <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#00ff88">${totalSent}</div><div style="color:#aaa;font-size:.8rem">Enviados</div></div>
                <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#f87171">${totalFailed}</div><div style="color:#aaa;font-size:.8rem">Fallos individuales</div></div>
                <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#fbbf24">${totalCleaned}</div><div style="color:#aaa;font-size:.8rem">Tokens limpiados</div></div>
                <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#6366f1">${totalSegment}</div><div style="color:#aaa;font-size:.8rem">Total con app</div></div>
                <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700">${batchNum}</div><div style="color:#aaa;font-size:.8rem">Lotes ejecutados</div></div>
            </div>`;

        let resumeHtml = '';
        if (failed && failedAtOffset !== null) {
            const resumeOffset = failedAtOffset + NOTIF_ALL_APP_BATCH_SIZE;
            resumeHtml = `
                <div style="margin-top:1rem;padding:.85rem 1rem;background:rgba(99,102,241,.07);border:1px solid rgba(99,102,241,.3);border-radius:8px;font-size:.88rem;line-height:1.45">
                    <div style="margin-bottom:.5rem;color:#e0e0e0">
                        <strong>El lote en offset ${failedAtOffset} NO se reintentó automáticamente</strong> para evitar duplicar mensajes a usuarios que ya hayan recibido.
                    </div>
                    <div style="margin-bottom:.7rem;color:#cbd5e1">Tenés dos opciones para continuar:</div>
                    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
                        <button class="btn btn-primary btn-sm" onclick="resumeSendAllWithApp(${resumeOffset})" style="background:linear-gradient(135deg,#059669,#10b981)">
                            ▶ Reanudar desde usuario N° ${resumeOffset} (recomendado)
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="retrySendAllWithApp(${failedAtOffset})">
                            🔁 Reintentar el lote fallido (offset ${failedAtOffset})
                        </button>
                    </div>
                    <div style="margin-top:.6rem;color:#aaa;font-size:.78rem;line-height:1.4">
                        ⚠️ <strong>Reanudar</strong> avanza al siguiente lote: cero riesgo de duplicar, pero si el lote ${failedAtOffset} alcanzó a enviar a algunos usuarios antes de fallar, esos usuarios ya recibieron y los demás del mismo lote se saltarán.<br>
                        ⚠️ <strong>Reintentar</strong> el lote fallido vuelve a procesar los 100 usuarios desde offset ${failedAtOffset}: usalo solo si estás seguro de que el lote NO alcanzó a enviar nada (ej. error de red antes de llegar al server).
                    </div>
                </div>`;
        }

        resultContent.innerHTML = headerHtml + statsHtml + resumeHtml;
    }

    if (progressEl) {
        progressEl.textContent = failed
            ? `❌ Detenido en lote ${batchNum} (offset ${failedAtOffset}). Enviados hasta ahora: ${totalSent}.`
            : `✅ Envío completo: ${totalSent} enviados a usuarios con app.`;
    }

    if (!failed) {
        showToast(`✅ Enviado a ${totalSent} usuarios con app`, 'success');
    } else {
        showToast(`⚠️ Envío detenido en lote ${batchNum}. ${totalSent} enviados hasta ahora.`, 'warning');
    }

    loadNotificationsPanel();
}

// Reanuda el envío masivo desde un offset específico (sin reintentar el lote fallido).
function resumeSendAllWithApp(offset) {
    sendAllWithApp(offset);
}

// Reintenta el lote fallido (puede duplicar mensajes — requiere confirm explícito).
function retrySendAllWithApp(offset) {
    if (!confirm(
        `¿Reintentar el lote en offset ${offset}?\n\n` +
        `⚠️ ATENCIÓN: si el lote llegó a enviar a algunos usuarios antes de fallar, ` +
        `esos usuarios van a recibir el mensaje DOS VECES. ` +
        `Solo confirmá si estás seguro de que el lote no alcanzó a enviar nada ` +
        `(por ejemplo, si fue un error de red antes de llegar al servidor).`
    )) return;
    sendAllWithApp(offset);
}

async function cleanInvalidTokens() {
    if (!confirm('¿Verificar y limpiar tokens inválidos? Esto enviará una notificación de prueba silenciosa a cada usuario con token. Puede tardar unos minutos.')) return;

    const btn = document.querySelector('button[onclick="cleanInvalidTokens()"]');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Verificando...'; }

    try {
        const res = await fetch(`${API_URL}/api/notifications/verify-tokens`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ sendTest: false })
        });
        const data = await res.json();
        if (data.success) {
            const r = data.results;
            showToast(`🧹 Verificación completada: ${r.valid} válidos, ${r.invalid} inválidos, ${r.cleaned} limpiados`, 'success');
            loadNotificationsPanel();
        } else {
            showToast('❌ Error en verificación de tokens', 'error');
        }
    } catch (e) {
        showToast('❌ Error de conexión', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🧹 Limpiar tokens inválidos'; }
    }
}

// Mostrar/ocultar campo de usuarios específicos según segmento seleccionado
document.addEventListener('DOMContentLoaded', () => {
    const segmentSelect = document.getElementById('notifSegment');
    if (segmentSelect) {
        segmentSelect.addEventListener('change', () => {
            const specificDiv = document.getElementById('notifSpecificUsers');
            if (specificDiv) specificDiv.style.display = segmentSelect.value === 'specific' ? 'block' : 'none';
            updateNotifNextBatchVisibility();
        });
    }

    // Inicializar UI de modo de notificaciones
    updateNotifModeUI();

    // Búsqueda de usuarios en la sección Usuarios
    const searchUsersInput = document.getElementById('searchUsers');
    if (searchUsersInput) {
        searchUsersInput.addEventListener('input', debounce(() => {
            filterAndRenderUsers();
        }, 300));
    }
});

// Exponer funciones del panel de notificaciones al scope global (usadas por onclick)
window.loadNotificationsPanel = loadNotificationsPanel;
window.loadNotifUsers = loadNotifUsers;
window.sendBatchNotification = sendBatchNotification;
window.sendNextBatch = sendNextBatch;
window.resetNotifBatch = resetNotifBatch;
window.cleanInvalidTokens = cleanInvalidTokens;
window.updateNotifModeUI = updateNotifModeUI;
window.sendAllWithApp = sendAllWithApp;
window.resumeSendAllWithApp = resumeSendAllWithApp;
window.retrySendAllWithApp = retrySendAllWithApp;
window.applyDatosRange = applyDatosRange;

// =============================================
// PANEL DE REFERIDOS - ADMIN
// =============================================

function escHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmtARS(n) {
    return '$' + new Intl.NumberFormat('es-AR').format(Math.round(n || 0));
}

function fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });
}

function fmtPeriod(pk) {
    if (!pk) return '—';
    const [y, m] = pk.split('-');
    return `${m}/${y}`;
}

// Cached referrers for client-side quick filters
let cachedReferrers = [];

async function loadAdminReferralSummary() {
    const container = document.getElementById('referralTopList');
    const summaryContainer = document.getElementById('referralGlobalSummary');
    if (!container) return;
    container.innerHTML = '<span style="color:#888;">Cargando...</span>';
    // Always load payouts independently
    loadAdminReferralPayouts();
    try {
        const res = await fetch(`${API_URL}/api/referrals/admin/summary`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!res.ok) { container.innerHTML = '<span style="color:#ff4444;">Error cargando datos.</span>'; return; }
        const data = await res.json();
        const referrers = data.data?.topReferrers || [];
        const summary = data.data?.summary || {};

        // Cache for quick filters
        cachedReferrers = referrers;

        // Render global dashboard cards
        if (summaryContainer) {
            const card = (value, label, color, bg) =>
                `<div style="background:${bg};border:1px solid ${color}33;border-radius:10px;padding:14px 10px;text-align:center;">
                    <div style="font-size:22px;font-weight:bold;color:${color};">${value}</div>
                    <div style="font-size:11px;color:#888;margin-top:4px;">${label}</div>
                 </div>`;
            summaryContainer.innerHTML =
                card(summary.totalReferrers || 0, 'Referidores activos', '#d4af37', 'rgba(212,175,55,0.05)') +
                card(summary.totalReferred || 0, 'Usuarios referidos', '#00ff88', 'rgba(0,255,136,0.05)') +
                card(fmtARS(summary.totalHistoricalPaid || 0), 'Total pagado', '#00ff88', 'rgba(0,255,136,0.05)') +
                card(fmtARS(summary.totalPending || 0), 'Pendiente de pago', '#f7931e', 'rgba(247,147,30,0.05)') +
                card(fmtARS(summary.totalGenerated || 0), 'Total generado', '#b0b0b0', 'rgba(255,255,255,0.03)') +
                card(summary.totalPayouts || 0, 'Pagos realizados', '#888', 'rgba(255,255,255,0.03)') +
                card(fmtARS(summary.currentPeriodPending || 0), `Pendiente ${summary.currentPeriodKey || ''}`, '#f7931e', 'rgba(247,147,30,0.05)');
        }

        if (referrers.length === 0) {
            container.innerHTML = '<span style="color:#888;">No hay referidores activos todavía.</span>';
            return;
        }

        renderReferrersTable(referrers);
    } catch (e) {
        container.innerHTML = '<span style="color:#ff4444;">Error: ' + e.message + '</span>';
    }
}

/**
 * Render the referrers table with an optional client-side filter.
 * filter: 'all' | 'pending' | 'failed'
 */
function renderReferrersTable(referrers) {
    const container = document.getElementById('referralTopList');
    if (!container) return;

    if (referrers.length === 0) {
        container.innerHTML = '<span style="color:#888;">No hay referidores que coincidan con el filtro.</span>';
        return;
    }

    const payoutStatusBadge = (status) => {
        if (!status) return '<span style="color:#444;font-size:10px;">—</span>';
        if (status === 'paid') return '<span style="background:rgba(0,255,136,0.12);border:1px solid rgba(0,255,136,0.35);color:#00ff88;font-size:10px;border-radius:4px;padding:2px 6px;">✅ Pagado</span>';
        if (status === 'failed') return '<span style="background:rgba(255,68,68,0.12);border:1px solid rgba(255,68,68,0.35);color:#ff4444;font-size:10px;border-radius:4px;padding:2px 6px;">❌ Fallido</span>';
        if (status === 'pending') return '<span style="background:rgba(247,147,30,0.12);border:1px solid rgba(247,147,30,0.35);color:#f7931e;font-size:10px;border-radius:4px;padding:2px 6px;">⏳ Pendiente</span>';
        return `<span style="color:#888;font-size:10px;">${escHtml(status)}</span>`;
    };

    container.innerHTML = `
    <div style="overflow-x:auto;">
    <table id="referrersTableEl" style="width:100%;border-collapse:collapse;min-width:780px;">
        <thead><tr style="color:#888;font-size:11px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.1);">
            <th style="padding:7px 6px;">Usuario</th>
            <th style="padding:7px 6px;">Código</th>
            <th style="padding:7px 6px;text-align:center;">Referidos</th>
            <th style="padding:7px 6px;text-align:right;">Total Pagado</th>
            <th style="padding:7px 6px;text-align:right;">Pendiente</th>
            <th style="padding:7px 6px;text-align:right;">Total Generado</th>
            <th style="padding:7px 6px;">Último Pago</th>
            <th style="padding:7px 6px;">Último Estado</th>
            <th style="padding:7px 6px;">Acciones</th>
        </tr></thead>
        <tbody>
        ${referrers.map(r => {
            const fs = r.financialStats || {};
            const hasPending = (fs.totalPendingCommission || 0) > 0;
            return `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                <td style="padding:7px 6px;color:#fff;font-weight:bold;">${r.username}${r.excludedFromReferral ? ' <span style="color:#ff4444;font-size:10px;">EXCLUIDO</span>' : ''}</td>
                <td style="padding:7px 6px;color:#d4af37;letter-spacing:2px;font-size:12px;">${r.referralCode || '—'}</td>
                <td style="padding:7px 6px;color:#00ff88;font-weight:bold;text-align:center;">${r.totalReferreds}</td>
                <td style="padding:7px 6px;color:#00ff88;text-align:right;">${fmtARS(fs.totalSettledCommission || 0)}</td>
                <td style="padding:7px 6px;text-align:right;">
                    <span style="color:${hasPending?'#f7931e':'#888'};font-weight:${hasPending?'bold':'normal'};">${fmtARS(fs.totalPendingCommission || 0)}</span>
                    ${hasPending ? '<span style="color:#f7931e;font-size:10px;margin-left:4px;">●</span>' : ''}
                </td>
                <td style="padding:7px 6px;color:#b0b0b0;text-align:right;">${fmtARS(fs.totalGenerated || 0)}</td>
                <td style="padding:7px 6px;color:#888;font-size:11px;">${fs.lastPayoutDate ? new Date(fs.lastPayoutDate).toLocaleDateString('es-AR') : '—'}</td>
                <td style="padding:7px 6px;">${payoutStatusBadge(fs.latestPayoutStatus)}</td>
                <td style="padding:7px 6px;"><button onclick="loadAdminUserReferrals('${r.id}')" style="background:rgba(212,175,55,0.1);border:1px solid #d4af37;color:#d4af37;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;">Ver detalle</button></td>
            </tr>`;
        }).join('')}
        </tbody>
    </table>
    </div>`;
}

/**
 * Filter the referrers table client-side (no extra API call).
 * mode: 'all' | 'pending' | 'failed'
 */
function filterReferrersTable(mode) {
    // Highlight active filter button
    ['referralFilterAll', 'referralFilterPending', 'referralFilterFailed'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.style.opacity = '0.5';
        btn.style.fontWeight = 'normal';
    });
    const activeId = mode === 'pending' ? 'referralFilterPending' : mode === 'failed' ? 'referralFilterFailed' : 'referralFilterAll';
    const activeBtn = document.getElementById(activeId);
    if (activeBtn) { activeBtn.style.opacity = '1'; activeBtn.style.fontWeight = 'bold'; }

    if (!cachedReferrers.length) return;

    let filtered = cachedReferrers;
    if (mode === 'pending') {
        filtered = cachedReferrers.filter(r => (r.financialStats?.totalPendingCommission || 0) > 0);
    } else if (mode === 'failed') {
        filtered = cachedReferrers.filter(r => r.financialStats?.latestPayoutStatus === 'failed');
    }
    renderReferrersTable(filtered);
}

async function loadAdminReferralPayouts() {
    const container = document.getElementById('referralPayoutList');
    if (!container) return;
    container.innerHTML = '<span style="color:#888;font-size:12px;">Cargando...</span>';
    try {
        const statusFilter = document.getElementById('referralPayoutFilterStatus')?.value || '';
        const deltaFilter = document.getElementById('referralPayoutFilterDelta')?.value || '';
        const periodFilter = document.getElementById('referralPayoutFilterPeriod')?.value?.trim() || '';
        const usernameFilter = document.getElementById('referralPayoutFilterUsername')?.value?.trim() || '';
        const params = new URLSearchParams({ limit: 100 }); // 100 payouts to support period-grouped display (multiple payouts per referrer/period)
        if (statusFilter) params.append('status', statusFilter);
        if (deltaFilter) params.append('isDelta', deltaFilter);
        if (periodFilter && /^\d{4}-\d{2}$/.test(periodFilter)) params.append('period', periodFilter);
        if (usernameFilter) params.append('username', usernameFilter);

        const res = await fetch(`${API_URL}/api/referrals/admin/payouts?${params}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!res.ok) {
            container.innerHTML = '<span style="color:#ff4444;font-size:12px;">Error cargando historial de pagos.</span>';
            return;
        }
        const data = await res.json();
        const payouts = data.data?.payouts || [];
        if (payouts.length === 0) {
            container.innerHTML = '<span style="color:#888;padding:12px;display:block;">No hay pagos registrados para los filtros aplicados.</span>';
            return;
        }

        const statusBadge = (s, isDelta, idx) => {
            const color = s === 'paid' ? '#00ff88' : s === 'failed' ? '#ff4444' : '#f7931e';
            const label = s === 'paid' ? '✅ Pagado' : s === 'failed' ? '❌ Fallido' : '⏳ Pendiente';
            const seqLabel = idx > 1 || isDelta
                ? `<span style="background:rgba(212,175,55,0.15);border:1px solid rgba(212,175,55,0.4);color:#d4af37;font-size:10px;border-radius:4px;padding:1px 5px;margin-left:5px;">Δ pago #${idx}</span>`
                : '';
            return `<span style="color:${color};font-size:11px;">${label}</span>${seqLabel}`;
        };

        // Group by period for sectioned display
        const byPeriod = new Map();
        for (const p of payouts) {
            const key = p.periodKey || '?';
            if (!byPeriod.has(key)) byPeriod.set(key, []);
            byPeriod.get(key).push(p);
        }

        let html = '';
        for (const [pk, periodPayouts] of byPeriod) {
            const periodLabel = periodPayouts[0].periodLabel || pk;
            const periodTotal = periodPayouts.filter(p => p.status === 'paid').reduce((s, p) => s + (p.totalCommissionAmount || 0), 0);
            const hasMultiple = periodPayouts.some(p => (p.payoutIndex || 1) > 1 || p.isDelta);

            html += `
            <div style="margin-bottom:16px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(212,175,55,0.15);">
                    <span style="color:#d4af37;font-weight:bold;font-size:13px;">📅 ${escHtml(periodLabel)}</span>
                    <div style="display:flex;align-items:center;gap:10px;">
                        ${hasMultiple ? '<span style="background:rgba(212,175,55,0.1);border:1px solid rgba(212,175,55,0.3);color:#d4af37;font-size:10px;border-radius:4px;padding:2px 7px;">múltiples pagos</span>' : ''}
                        <span style="color:#888;font-size:11px;">Total acreditado: <strong style="color:#00ff88;">${fmtARS(periodTotal)}</strong></span>
                    </div>
                </div>
                <div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;min-width:600px;">
                    <thead><tr style="color:#888;font-size:11px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.08);">
                        <th style="padding:6px 6px;">Referidor</th>
                        <th style="padding:6px 6px;text-align:right;">Monto Acreditado</th>
                        <th style="padding:6px 6px;text-align:center;">Referidos</th>
                        <th style="padding:6px 6px;">Estado / Liquidación</th>
                        <th style="padding:6px 6px;">Fecha Pago</th>
                        <th style="padding:6px 6px;font-size:10px;">ID</th>
                    </tr></thead>
                    <tbody>
                    ${periodPayouts.map(p => {
                        const rowBg = p.isDelta || (p.payoutIndex || 1) > 1 ? 'background:rgba(212,175,55,0.02);' : '';
                        return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);${rowBg}">
                            <td style="padding:6px 6px;color:#fff;font-weight:bold;">
                                ${escHtml(p.referrerUsername)}
                                <button onclick="loadAdminUserReferrals('${escHtml(p.referrerUserId || '')}');document.getElementById('referralUserDetail')?.scrollIntoView({behavior:'smooth'})"
                                    style="background:none;border:1px solid rgba(212,175,55,0.4);color:#d4af37;padding:1px 6px;border-radius:4px;cursor:pointer;font-size:10px;margin-left:5px;">detalle</button>
                            </td>
                            <td style="padding:6px 6px;color:#d4af37;font-weight:bold;text-align:right;">${fmtARS(p.totalCommissionAmount || 0)}</td>
                            <td style="padding:6px 6px;color:#00ff88;text-align:center;">${p.referralCount || 0}</td>
                            <td style="padding:6px 6px;">${statusBadge(p.status, p.isDelta, p.payoutIndex || 1)}</td>
                            <td style="padding:6px 6px;color:#888;font-size:11px;">${p.creditedAt ? new Date(p.creditedAt).toLocaleString('es-AR', {dateStyle:'short',timeStyle:'short'}) : '—'}</td>
                            <td style="padding:6px 6px;color:#444;font-size:10px;font-family:monospace;">${(p.id || '').substring(0, 8)}…</td>
                        </tr>`;
                    }).join('')}
                    </tbody>
                </table>
                </div>
            </div>`;
        }

        container.innerHTML = `
            <div style="color:#888;font-size:11px;margin-bottom:12px;">
                ${payouts.length} pago(s) — ordenado por período más reciente
            </div>
            ${html}`;
    } catch (e) {
        container.innerHTML = '<span style="color:#ff4444;font-size:12px;">Error cargando historial de pagos.</span>';
    }
}

async function loadAdminUserReferrals(userId) {
    const detailPanel = document.getElementById('referralUserDetail');
    const detailContent = document.getElementById('referralUserDetailContent');
    if (detailPanel) detailPanel.style.display = 'block';
    if (detailContent) detailContent.innerHTML = '<span style="color:#888;">Cargando detalle...</span>';
    // Scroll to detail
    if (detailPanel) detailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
        const res = await fetch(`${API_URL}/api/referrals/admin/users/${userId}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!res.ok) {
            if (detailContent) detailContent.innerHTML = '<span style="color:#ff4444;">Error cargando detalle del referidor.</span>';
            return;
        }
        const data = await res.json();
        const d = data.data;
        const u = d.user;
        const fs = d.financialSummary || {};

        const referredRows = (d.referredUsers || []).map(ru => `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                <td style="padding:5px 6px;color:#fff;">${ru.username}</td>
                <td style="padding:5px 6px;color:#b0b0b0;font-size:11px;">${fmtDate(ru.referredAt)}</td>
                <td style="padding:5px 6px;">
                    <span style="color:${ru.referralStatus==='active'?'#00ff88':ru.referralStatus==='referred'?'#f7931e':'#888'};font-size:11px;">${ru.referralStatus || '—'}</span>
                </td>
                <td style="padding:5px 6px;color:${ru.excludedFromReferral?'#ff4444':'#888'};font-size:11px;">${ru.excludedFromReferral ? '❌ Excluido' : '✅ Activo'}</td>
            </tr>
        `).join('');

        // Enriched commission rows with paid/pending breakdown
        const commissionRows = (d.commissions || []).slice(0, 30).map(c => {
            const alreadyPaid = c.alreadyPaidAmount != null ? c.alreadyPaidAmount : (c.settledCommissionAmount || 0);
            // pendingAmount from API is always commissionAmount when > 0 (status-independent)
            const pending = c.pendingAmount != null ? c.pendingAmount : (c.commissionAmount > 0 ? c.commissionAmount : 0);
            const isDelta = c.isDelta || alreadyPaid > 0;
            const statusColor = c.status === 'paid' ? '#00ff88' : c.status === 'calculated' ? '#f7931e' : c.status === 'excluded' ? '#ff4444' : '#888';
            const statusLabel = c.status === 'paid' ? '✅ Pagado' : c.status === 'calculated' ? '⏳ Pendiente' : c.status === 'excluded' ? '🚫 Excluido' : c.status;
            return `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);${isDelta?'background:rgba(212,175,55,0.03);':''}">
                <td style="padding:5px 6px;color:#b0b0b0;">${fmtPeriod(c.periodKey)}${isDelta?'<span style="color:#d4af37;font-size:10px;margin-left:3px;">Δ</span>':''}</td>
                <td style="padding:5px 6px;color:#fff;">${c.referredUsername}</td>
                <td style="padding:5px 6px;color:#888;text-align:right;">${fmtARS(c.totalOwnerRevenue)}</td>
                <td style="padding:5px 6px;color:#00ff88;text-align:right;font-size:11px;">${fmtARS(alreadyPaid)}</td>
                <td style="padding:5px 6px;text-align:right;">
                    <span style="color:${pending>0?'#f7931e':'#888'};font-weight:${pending>0?'bold':'normal'};">${fmtARS(pending)}</span>
                </td>
                <td style="padding:5px 6px;color:#d4af37;font-weight:bold;text-align:right;">${fmtARS(alreadyPaid + pending)}</td>
                <td style="padding:5px 6px;"><span style="color:${statusColor};font-size:11px;">${statusLabel}</span></td>
            </tr>`;
        }).join('');

        // Group payouts by period to show settlement timeline
        const payoutsByPeriod = new Map();
        for (const p of (d.payouts || [])) {
            const key = p.periodKey || '?';
            if (!payoutsByPeriod.has(key)) payoutsByPeriod.set(key, []);
            payoutsByPeriod.get(key).push(p);
        }

        let payoutTimelineHtml = '';
        for (const [pk, pps] of payoutsByPeriod) {
            const periodLbl = (pps[0].periodLabel || fmtPeriod(pk));
            const periodSum = pps.filter(p => p.status === 'paid').reduce((s, p) => s + (p.totalCommissionAmount || 0), 0);
            const multiPayout = pps.length > 1;
            payoutTimelineHtml += `
            <div style="margin-bottom:10px;padding:10px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <span style="color:#d4af37;font-size:12px;font-weight:bold;">📅 ${escHtml(periodLbl)}</span>
                    <div style="display:flex;align-items:center;gap:8px;">
                        ${multiPayout ? `<span style="background:rgba(212,175,55,0.12);border:1px solid rgba(212,175,55,0.35);color:#d4af37;font-size:10px;border-radius:4px;padding:1px 6px;">${pps.length} pagos en este período</span>` : ''}
                        <span style="color:#888;font-size:11px;">Total: <strong style="color:#00ff88;">${fmtARS(periodSum)}</strong></span>
                    </div>
                </div>
                ${pps.map((p, i) => {
                    const isDelta = p.isDelta || (p.payoutIndex || 1) > 1;
                    const statusColor = p.status === 'paid' ? '#00ff88' : p.status === 'failed' ? '#ff4444' : '#f7931e';
                    const statusLabel = p.status === 'paid' ? '✅ Pagado' : p.status === 'failed' ? '❌ Fallido' : '⏳ Pendiente';
                    return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;${i > 0 ? 'border-top:1px solid rgba(255,255,255,0.04);' : ''}">
                        <span style="color:#888;font-size:11px;min-width:50px;">Pago ${p.payoutIndex ? `#${p.payoutIndex}` : '#1'}</span>
                        ${isDelta ? '<span style="background:rgba(212,175,55,0.15);border:1px solid rgba(212,175,55,0.4);color:#d4af37;font-size:10px;border-radius:4px;padding:1px 5px;">Δ delta</span>' : '<span style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#888;font-size:10px;border-radius:4px;padding:1px 5px;">base</span>'}
                        <span style="color:#d4af37;font-weight:bold;min-width:80px;text-align:right;">${fmtARS(p.totalCommissionAmount)}</span>
                        <span style="color:${statusColor};font-size:11px;">${statusLabel}</span>
                        <span style="color:#888;font-size:11px;margin-left:auto;">${fmtDate(p.creditedAt)}</span>
                    </div>`;
                }).join('')}
            </div>`;
        }

        if (detailContent) {
            detailContent.innerHTML = `
                <!-- Financial header -->
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px;text-align:center;">
                        <div style="color:#888;font-size:10px;margin-bottom:4px;">USUARIO</div>
                        <div style="color:#fff;font-weight:bold;">${u.username}</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px;text-align:center;">
                        <div style="color:#888;font-size:10px;margin-bottom:4px;">CÓDIGO</div>
                        <div style="color:#d4af37;letter-spacing:2px;font-weight:bold;">${u.referralCode || '—'}</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px;text-align:center;">
                        <div style="color:#888;font-size:10px;margin-bottom:4px;">REFERIDOS</div>
                        <div style="color:#00ff88;font-weight:bold;font-size:20px;">${d.totalReferred}</div>
                    </div>
                    <div style="background:rgba(0,255,136,0.03);border:1px solid rgba(0,255,136,0.15);border-radius:8px;padding:10px;text-align:center;">
                        <div style="color:#888;font-size:10px;margin-bottom:4px;">TOTAL PAGADO</div>
                        <div style="color:#00ff88;font-weight:bold;">${fmtARS(fs.totalSettledCommission || d.totalCommissionHistorical || 0)}</div>
                    </div>
                    <div style="background:rgba(247,147,30,0.03);border:1px solid rgba(247,147,30,0.15);border-radius:8px;padding:10px;text-align:center;">
                        <div style="color:#888;font-size:10px;margin-bottom:4px;">PENDIENTE</div>
                        <div style="color:#f7931e;font-weight:bold;">${fmtARS(fs.totalPendingCommission || 0)}</div>
                    </div>
                    <div style="background:rgba(212,175,55,0.03);border:1px solid rgba(212,175,55,0.12);border-radius:8px;padding:10px;text-align:center;">
                        <div style="color:#888;font-size:10px;margin-bottom:4px;">TOTAL GENERADO</div>
                        <div style="color:#d4af37;font-weight:bold;">${fmtARS(fs.totalGeneratedCommission || 0)}</div>
                    </div>
                    ${u.excludedFromReferral ? '<div style="background:rgba(255,68,68,0.05);border:1px solid rgba(255,68,68,0.2);border-radius:8px;padding:10px;text-align:center;grid-column:span 2;"><span style="color:#ff4444;font-size:12px;">⚠️ USUARIO EXCLUIDO DEL SISTEMA DE REFERIDOS</span></div>' : ''}
                </div>

                ${d.referredUsers && d.referredUsers.length > 0 ? `
                <div style="margin-bottom:16px;">
                    <h4 style="color:#d4af37;margin-bottom:8px;font-size:13px;">👥 Usuarios Referidos (${d.referredUsers.length})</h4>
                    <div style="overflow-x:auto;">
                    <table style="width:100%;border-collapse:collapse;min-width:400px;">
                        <thead><tr style="color:#888;font-size:11px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.1);">
                            <th style="padding:5px 6px;">Usuario</th>
                            <th style="padding:5px 6px;">Registro</th>
                            <th style="padding:5px 6px;">Estado</th>
                            <th style="padding:5px 6px;">Acceso</th>
                        </tr></thead>
                        <tbody>${referredRows}</tbody>
                    </table>
                    </div>
                </div>` : '<div style="color:#888;font-size:12px;margin-bottom:14px;">Sin usuarios referidos en la base de datos.</div>'}

                ${d.commissions && d.commissions.length > 0 ? `
                <div style="margin-bottom:16px;">
                    <h4 style="color:#d4af37;margin-bottom:8px;font-size:13px;">💰 Historial de Comisiones <span style="color:#888;font-size:11px;font-weight:normal;">(Δ = comisión delta tras pago previo)</span></h4>
                    <div style="overflow-x:auto;">
                    <table style="width:100%;border-collapse:collapse;min-width:600px;">
                        <thead><tr style="color:#888;font-size:11px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.1);">
                            <th style="padding:5px 6px;">Período</th>
                            <th style="padding:5px 6px;">Referido</th>
                            <th style="padding:5px 6px;text-align:right;">Rev. Dueño</th>
                            <th style="padding:5px 6px;text-align:right;color:#00ff88;">Ya Pagado</th>
                            <th style="padding:5px 6px;text-align:right;color:#f7931e;">Pendiente</th>
                            <th style="padding:5px 6px;text-align:right;">Total</th>
                            <th style="padding:5px 6px;">Estado</th>
                        </tr></thead>
                        <tbody>${commissionRows}</tbody>
                    </table>
                    </div>
                </div>` : '<div style="color:#888;font-size:12px;margin-bottom:14px;">Sin comisiones calculadas aún. Usá Preview/Calcular para generar los datos.</div>'}

                ${d.payouts && d.payouts.length > 0 ? `
                <div>
                    <h4 style="color:#d4af37;margin-bottom:8px;font-size:13px;">📤 Historial de Pagos Realizados <span style="color:#888;font-size:11px;font-weight:normal;">(Δ = pago delta, liquidación posterior al corte inicial)</span></h4>
                    ${payoutTimelineHtml}
                </div>` : '<div style="color:#888;font-size:12px;">Sin pagos realizados aún.</div>'}
            `;
        }
    } catch (e) {
        if (detailContent) detailContent.innerHTML = '<span style="color:#ff4444;">Error: ' + e.message + '</span>';
    }
}

async function loadAdminReferralRelationships() {
    const container = document.getElementById('referralRelationshipsList');
    if (!container) return;
    container.innerHTML = '<span style="color:#888;">Cargando relaciones...</span>';
    const referrerFilter = document.getElementById('referralRelFilterReferrer')?.value?.trim() || '';
    const referredFilter = document.getElementById('referralRelFilterReferred')?.value?.trim() || '';
    const params = new URLSearchParams({ limit: 200 });
    if (referrerFilter) params.append('referrerUsername', referrerFilter);
    if (referredFilter) params.append('referredUsername', referredFilter);
    try {
        const res = await fetch(`${API_URL}/api/referrals/admin/relationships?${params}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!res.ok) {
            container.innerHTML = '<span style="color:#ff4444;">Error cargando relaciones. Verificar que el endpoint exista.</span>';
            return;
        }
        const data = await res.json();
        const rels = data.data?.relationships || [];
        const msg = data.data?.message || null;

        if (rels.length === 0) {
            container.innerHTML = `<div style="color:#888;padding:12px;background:rgba(255,255,255,0.03);border-radius:8px;">
                ${msg || 'No se encontraron relaciones de referido.'}
                <br><br>
                <span style="color:#f7931e;font-size:12px;">
                    ℹ️ Si ya se realizó un registro con código de referido, verificá que el campo <code>referredByUserId</code> esté guardado en ese usuario.
                    Si la cuenta fue creada antes de este fix, la atribución no se habrá guardado.
                </span>
            </div>`;
            return;
        }

        container.innerHTML = `
            <div style="margin-bottom:8px;font-size:12px;color:#888;">Total: ${data.data?.pagination?.total || rels.length} relaciones encontradas</div>
            <table style="width:100%;border-collapse:collapse;">
                <thead><tr style="color:#888;font-size:11px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.1);">
                    <th style="padding:6px 4px;">Referidor</th>
                    <th style="padding:6px 4px;">Código usado</th>
                    <th style="padding:6px 4px;">Referido</th>
                    <th style="padding:6px 4px;">Usuario JG</th>
                    <th style="padding:6px 4px;">Fecha registro</th>
                    <th style="padding:6px 4px;">Estado</th>
                    <th style="padding:6px 4px;">Excluido</th>
                </tr></thead>
                <tbody>
                ${rels.map(r => `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:5px 4px;">
                        <span style="color:#d4af37;font-weight:bold;">${r.referrer?.username || '—'}</span>
                        ${r.referrer?.id ? `<button onclick="loadAdminUserReferrals('${r.referrer.id}')" style="background:rgba(212,175,55,0.1);border:1px solid #d4af37;color:#d4af37;padding:2px 6px;border-radius:4px;cursor:pointer;font-size:10px;margin-left:4px;">Detalle</button>` : ''}
                    </td>
                    <td style="padding:5px 4px;color:#d4af37;letter-spacing:1px;font-size:12px;">${r.codeUsed || '—'}</td>
                    <td style="padding:5px 4px;color:#fff;">${r.referredUsername}</td>
                    <td style="padding:5px 4px;color:#888;font-size:11px;">${r.jugayganaUsername || r.referredUsername}</td>
                    <td style="padding:5px 4px;color:#b0b0b0;font-size:11px;">${fmtDate(r.referredAt)}</td>
                    <td style="padding:5px 4px;">
                        <span style="color:${r.referralStatus==='active'?'#00ff88':r.referralStatus==='referred'?'#f7931e':'#888'};font-size:11px;">${r.referralStatus || '—'}</span>
                    </td>
                    <td style="padding:5px 4px;color:${r.excludedFromReferral?'#ff4444':'#888'};font-size:11px;">${r.excludedFromReferral ? '❌' : '✅'}</td>
                </tr>`).join('')}
                </tbody>
            </table>
        `;
    } catch (e) {
        container.innerHTML = '<span style="color:#ff4444;">Error: ' + e.message + '</span>';
    }
}

function renderReferralCalcResult(data, container, actionLabel) {
    if (!container) return;
    if (!data) { container.innerHTML = '<span style="color:#ff4444;">Sin datos en la respuesta.</span>'; return; }

    const statusColor = (s) => {
        if (s === 'calculated') return '#d4af37';
        if (s === 'skipped') return '#888';
        if (s === 'excluded') return '#ff4444';
        if (s === 'error') return '#ff6666';
        if (s === 'paid') return '#00ff88';
        return '#b0b0b0';
    };

    const details = data.details || [];
    const errors = data.errors || [];

    let html = `
        <div style="background:rgba(255,255,255,0.03);border-radius:8px;padding:12px;margin-bottom:10px;">
            <div style="font-size:14px;font-weight:bold;color:#d4af37;margin-bottom:8px;">📊 ${actionLabel} — Período ${fmtPeriod(data.periodKey)} ${data.dryRun ? '<span style="color:#888;font-size:11px;">(PREVIEW - no guardado)</span>' : ''}</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;">
                <div style="background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.2);border-radius:6px;padding:8px;text-align:center;">
                    <div style="color:#00ff88;font-size:18px;font-weight:bold;">${data.referrersProcessed}</div>
                    <div style="color:#888;font-size:11px;">Referidores procesados</div>
                </div>
                <div style="background:rgba(212,175,55,0.05);border:1px solid rgba(212,175,55,0.2);border-radius:6px;padding:8px;text-align:center;">
                    <div style="color:#d4af37;font-size:18px;font-weight:bold;">${data.referredsProcessed}</div>
                    <div style="color:#888;font-size:11px;">Referidos procesados</div>
                </div>
                <div style="background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.2);border-radius:6px;padding:8px;text-align:center;">
                    <div style="color:#00ff88;font-size:18px;font-weight:bold;">${data.commissionsCreated}</div>
                    <div style="color:#888;font-size:11px;">Comisiones generadas</div>
                </div>
                <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:8px;text-align:center;">
                    <div style="color:#888;font-size:18px;font-weight:bold;">${data.commissionsSkipped}</div>
                    <div style="color:#888;font-size:11px;">Sin revenue</div>
                </div>
                ${data.commissionsExcluded > 0 ? `
                <div style="background:rgba(255,68,68,0.05);border:1px solid rgba(255,68,68,0.2);border-radius:6px;padding:8px;text-align:center;">
                    <div style="color:#ff4444;font-size:18px;font-weight:bold;">${data.commissionsExcluded}</div>
                    <div style="color:#888;font-size:11px;">Excluidos</div>
                </div>` : ''}
            </div>
        </div>`;

    if (data.referrersProcessed === 0) {
        html += `<div style="background:rgba(247,147,30,0.08);border:1px solid rgba(247,147,30,0.3);border-radius:8px;padding:12px;margin-bottom:10px;color:#f7931e;font-size:13px;">
            ⚠️ <strong>Sin referidores procesados.</strong><br>
            Esto significa que ningún usuario tiene el campo <code>referredByUserId</code> guardado en la base de datos.<br>
            Las cuentas creadas con código de referido antes del fix no tienen atribución guardada.
            Para verificar, usá la sección <strong>"Relaciones de Referido (Auditoría)"</strong>.
        </div>`;
    }

    if (details.length > 0) {
        const revenueOkLabel = (d) => {
            if (d.status === 'excluded') return '<span style="color:#ff4444;font-size:10px;">excluido</span>';
            if (d.status === 'error') return '<span style="color:#ff6666;font-size:10px;">❌ error</span>';
            if (d.revenueOk === false) return '<span style="color:#ff6666;font-size:10px;">❌ error</span>';
            if (d.revenueOk === true) return '<span style="color:#00ff88;font-size:10px;">✓ ok</span>';
            return '<span style="color:#888;font-size:10px;">—</span>';
        };
        html += `<div style="margin-bottom:10px;">
            <div style="font-size:12px;color:#888;margin-bottom:6px;font-weight:600;">DETALLE POR REFERIDO:</div>
            <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;min-width:700px;">
                <thead><tr style="color:#888;font-size:11px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.1);">
                    <th style="padding:4px 6px;">Referido</th>
                    <th style="padding:4px 6px;">Usuario JG</th>
                    <th style="padding:4px 6px;">Período</th>
                    <th style="padding:4px 6px;">Revenue ok</th>
                    <th style="padding:4px 6px;">GGR</th>
                    <th style="padding:4px 6px;">Rev. Dueño</th>
                    <th style="padding:4px 6px;color:#00ff88;">Ya Pagado</th>
                    <th style="padding:4px 6px;color:#f7931e;">Pendiente</th>
                    <th style="padding:4px 6px;">Estado</th>
                    <th style="padding:4px 6px;">Nota</th>
                </tr></thead>
                <tbody>
                ${details.map(d => {
                    const alreadyPaid = d.alreadySettledCommission || 0;
                    const pending = d.commissionAmount || 0;
                    const isDelta = d.isDelta || alreadyPaid > 0;
                    return `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);${isDelta?'background:rgba(212,175,55,0.02);':''}">
                        <td style="padding:4px 6px;color:#fff;font-size:12px;">${escHtml(d.referredUsername)}${isDelta?'<span style="color:#d4af37;font-size:10px;margin-left:3px;" title="Delta: pago incremental">Δ</span>':''}</td>
                        <td style="padding:4px 6px;color:#aaa;font-size:11px;">${escHtml(d.jugayganaUsername != null ? d.jugayganaUsername : d.referredUsername)}</td>
                        <td style="padding:4px 6px;color:#888;font-size:11px;">${escHtml(d.periodKey || data.periodKey || '')}</td>
                        <td style="padding:4px 6px;">${revenueOkLabel(d)}</td>
                        <td style="padding:4px 6px;color:#b0b0b0;font-size:12px;">${d.status !== 'error' ? fmtARS(d.totalGgr != null ? d.totalGgr : 0) : '—'}</td>
                        <td style="padding:4px 6px;color:#b0b0b0;font-size:12px;">${d.status !== 'error' ? fmtARS(d.totalOwnerRevenue) : '—'}</td>
                        <td style="padding:4px 6px;color:#00ff88;font-size:12px;">${fmtARS(alreadyPaid)}</td>
                        <td style="padding:4px 6px;color:${pending>0?'#f7931e':'#888'};font-weight:${pending>0?'bold':'normal'};font-size:12px;">${fmtARS(pending)}</td>
                        <td style="padding:4px 6px;"><span style="color:${statusColor(d.status)};font-size:11px;">${escHtml(d.status)}</span></td>
                        <td style="padding:4px 6px;color:#888;font-size:10px;max-width:200px;word-break:break-word;">${escHtml(d.reason || '')}</td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>
            </div>
        </div>`;
    }

    if (errors.length > 0) {
        html += `<div style="background:rgba(255,68,68,0.05);border:1px solid rgba(255,68,68,0.2);border-radius:8px;padding:10px;margin-bottom:10px;">
            <div style="color:#ff4444;font-size:12px;margin-bottom:6px;font-weight:600;">ERRORES EN REVENUE (${errors.length}):</div>
            ${errors.map(e => `<div style="color:#ff8888;font-size:11px;margin-bottom:4px;">
                • <strong>${escHtml(e.referredUsername || '?')}</strong>${e.jugayganaUsername && e.jugayganaUsername !== e.referredUsername ? ` <span style="color:#888;">(JG: ${escHtml(e.jugayganaUsername)})</span>` : ''}
                ${e.periodKey ? `<span style="color:#888;"> período ${escHtml(e.periodKey)}</span>` : ''}
                → <span style="color:#ff6666;">${escHtml(e.error)}</span>
                ${e.statusCode ? `<span style="color:#888;font-size:10px;"> [HTTP ${e.statusCode}]</span>` : ''}
                ${e.providerResponse ? `<details style="margin-top:2px;"><summary style="color:#888;font-size:10px;cursor:pointer;">detalle proveedor</summary><pre style="color:#aaa;font-size:10px;white-space:pre-wrap;word-break:break-all;margin:2px 0 0 0;">${escHtml(e.providerResponse)}</pre></details>` : ''}
            </div>`).join('')}
        </div>`;
    }

    container.innerHTML = html;
}

function renderReferralCalcError(message, container) {
    if (!container) return;
    container.innerHTML = `<div style="background:rgba(255,68,68,0.08);border:1px solid rgba(255,68,68,0.3);border-radius:8px;padding:12px;">
        <div style="color:#ff4444;font-size:13px;font-weight:bold;margin-bottom:6px;">❌ Error en la operación</div>
        <div style="color:#ff8888;font-size:12px;">${escHtml(message)}</div>
    </div>`;
}

async function adminReferralPreview() {
    const period = document.getElementById('referralPeriodInput')?.value?.trim();
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
        showToast('⚠️ Ingresá el período en formato YYYY-MM', 'error'); return;
    }
    const resultDiv = document.getElementById('referralActionResult');
    if (resultDiv) resultDiv.innerHTML = '<span style="color:#888;">Calculando preview...</span>';
    try {
        const res = await fetch(`${API_URL}/api/referrals/admin/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ periodKey: period })
        });
        const data = await res.json();
        if (!res.ok || data.status !== 'success') {
            renderReferralCalcError(data.message || data.error || `HTTP ${res.status}`, resultDiv);
            return;
        }
        renderReferralCalcResult(data.data, resultDiv, '🔍 Preview');
    } catch (e) {
        renderReferralCalcError('Error de red: ' + e.message, resultDiv);
    }
}

async function adminReferralCalculate() {
    const period = document.getElementById('referralPeriodInput')?.value?.trim();
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
        showToast('⚠️ Ingresá el período en formato YYYY-MM', 'error'); return;
    }
    if (!confirm(`¿Calcular comisiones de referidos para ${period}? Esto guardará los cálculos en la base de datos.`)) return;
    const resultDiv = document.getElementById('referralActionResult');
    if (resultDiv) resultDiv.innerHTML = '<span style="color:#888;">Calculando...</span>';
    try {
        const res = await fetch(`${API_URL}/api/referrals/admin/calculate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ periodKey: period })
        });
        const data = await res.json();
        if (!res.ok || data.status !== 'success') {
            renderReferralCalcError(data.message || data.error || `HTTP ${res.status}`, resultDiv);
            showToast('❌ Error en cálculo', 'error');
            return;
        }
        renderReferralCalcResult(data.data, resultDiv, '📊 Cálculo');
        showToast('✅ Cálculo completado', 'success');
    } catch (e) {
        renderReferralCalcError('Error de red: ' + e.message, resultDiv);
        showToast('❌ Error en cálculo', 'error');
    }
}

async function adminReferralPayout() {
    const period = document.getElementById('referralPeriodInput')?.value?.trim();
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
        showToast('⚠️ Ingresá el período en formato YYYY-MM', 'error'); return;
    }
    if (!confirm(`⚠️ ¿Ejecutar pagos de referidos para ${period}? Esta acción acreditará fichas REALMENTE. Solo continuar si el cálculo fue verificado.`)) return;
    const resultDiv = document.getElementById('referralActionResult');
    if (resultDiv) resultDiv.innerHTML = '<span style="color:#888;">Procesando pagos...</span>';
    try {
        const res = await fetch(`${API_URL}/api/referrals/admin/payout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentToken}` },
            body: JSON.stringify({ periodKey: period })
        });
        const data = await res.json();
        const result = (data && data.data) || {};
        const created = result.payoutsCreated || 0;
        const failed = result.payoutsFailed || 0;
        const skipped = result.payoutsSkipped || 0;
        const details = result.details || [];
        const errors = result.errors || [];

        const renderPayoutResult = () => {
            const statusColor = data.status === 'success' ? '#00ff88' : data.status === 'partial' ? '#f7931e' : '#ff4444';
            const statusIcon = data.status === 'success' ? '✅' : data.status === 'partial' ? '⚠️' : '❌';

            let html = `
            <div style="background:rgba(255,255,255,0.03);border-radius:8px;padding:12px;margin-bottom:10px;">
                <div style="font-size:14px;font-weight:bold;color:${statusColor};margin-bottom:8px;">${statusIcon} Resultado del Pago — Período ${fmtPeriod(period)}</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:10px;">
                    <div style="background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.2);border-radius:6px;padding:8px;text-align:center;">
                        <div style="color:#00ff88;font-size:18px;font-weight:bold;">${created}</div>
                        <div style="color:#888;font-size:11px;">Pagos creados</div>
                    </div>
                    <div style="background:rgba(255,68,68,0.05);border:1px solid rgba(255,68,68,0.2);border-radius:6px;padding:8px;text-align:center;">
                        <div style="color:${failed > 0 ? '#ff4444' : '#888'};font-size:18px;font-weight:bold;">${failed}</div>
                        <div style="color:#888;font-size:11px;">Con error</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px;text-align:center;">
                        <div style="color:#888;font-size:18px;font-weight:bold;">${skipped}</div>
                        <div style="color:#888;font-size:11px;">Omitidos ($0)</div>
                    </div>
                </div>`;

            if (details.length > 0) {
                html += `<div style="margin-top:8px;">
                    <div style="color:#888;font-size:11px;margin-bottom:6px;font-weight:600;">DETALLE POR REFERIDOR:</div>
                    ${details.map(d => {
                        const isDelta = d.isDelta || (d.payoutIndex || 1) > 1;
                        const dColor = d.status === 'paid' ? '#00ff88' : '#ff4444';
                        return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
                            <span style="color:#fff;font-weight:bold;min-width:100px;">${escHtml(d.referrerUsername)}</span>
                            ${isDelta ? '<span style="background:rgba(212,175,55,0.15);border:1px solid rgba(212,175,55,0.4);color:#d4af37;font-size:10px;border-radius:4px;padding:1px 5px;">Δ delta</span>' : ''}
                            <span style="color:#d4af37;font-weight:bold;min-width:80px;text-align:right;">${fmtARS(d.amount || 0)}</span>
                            <span style="color:#00ff88;font-size:11px;">${d.referralCount || 0} referido(s)</span>
                            <span style="color:#888;font-size:11px;">pago #${d.payoutIndex || 1}</span>
                            <span style="color:${dColor};font-size:11px;margin-left:auto;">${d.status === 'paid' ? '✅ Acreditado' : '❌ Error'}</span>
                        </div>`;
                    }).join('')}
                </div>`;
            }

            if (errors.length > 0) {
                html += `<div style="background:rgba(255,68,68,0.05);border:1px solid rgba(255,68,68,0.2);border-radius:8px;padding:10px;margin-top:10px;">
                    <div style="color:#ff4444;font-size:12px;margin-bottom:6px;font-weight:600;">ERRORES (${errors.length}):</div>
                    ${errors.map(e => {
                        const who = e.referrer || e.referrerUsername || 'desconocido';
                        const rawMsg = e.message || e.error;
                        const msg = typeof rawMsg === 'string' ? rawMsg
                            : (rawMsg && (rawMsg.message || rawMsg.reason || rawMsg.code))
                                ? (rawMsg.message || rawMsg.reason || String(rawMsg.code))
                                : 'Error desconocido';
                        return `<div style="color:#ff8888;font-size:11px;margin-bottom:4px;">• <strong>${escHtml(who)}</strong> → ${escHtml(msg)}</div>`;
                    }).join('')}
                </div>`;
            }

            html += '</div>';
            return html;
        };

        if (!res.ok) {
            const errMsg = data?.message || data?.error || 'Error desconocido';
            if (resultDiv) resultDiv.innerHTML = `<div style="color:#ff4444;padding:8px;">❌ Error al procesar pagos: ${escHtml(errMsg)}</div>`;
            showToast('❌ Error en pagos', 'error');
        } else if (created > 0 && failed === 0) {
            if (resultDiv) resultDiv.innerHTML = renderPayoutResult();
            showToast('✅ Pagos procesados', 'success');
        } else if (created > 0 && failed > 0) {
            if (resultDiv) resultDiv.innerHTML = renderPayoutResult();
            showToast('⚠️ Pagos parciales', 'warning');
        } else if (failed > 0) {
            if (resultDiv) resultDiv.innerHTML = renderPayoutResult();
            showToast('❌ Error en pagos', 'error');
        } else if (skipped > 0 && created === 0 && failed === 0) {
            if (resultDiv) resultDiv.innerHTML = `<div style="color:#888;padding:8px;">ℹ️ Sin pagos pendientes para ${period} (${skipped} ya procesado(s) o sin monto).</div>`;
            showToast('ℹ️ Sin pagos pendientes', 'info');
        } else {
            if (resultDiv) resultDiv.innerHTML = '<span style="color:#f7931e;">Sin datos de pago para el período indicado.</span>';
        }
        loadAdminReferralSummary();
    } catch (e) {
        if (resultDiv) resultDiv.innerHTML = '<span style="color:#ff4444;">Error: ' + escHtml(e.message) + '</span>';
        showToast('❌ Error en pagos', 'error');
    }
}

// Exponer funciones de referidos al scope global
window.loadAdminReferralSummary = loadAdminReferralSummary;
window.loadAdminReferralPayouts = loadAdminReferralPayouts;
window.loadAdminUserReferrals = loadAdminUserReferrals;
window.loadAdminReferralRelationships = loadAdminReferralRelationships;
window.adminReferralPreview = adminReferralPreview;
window.adminReferralCalculate = adminReferralCalculate;
window.adminReferralPayout = adminReferralPayout;

// ============================================
// CAMBIAR CONTRASEÑA PROPIA DEL ADMIN
// ============================================
function showChangeOwnPasswordModal() {
    document.getElementById('ownCurrentPassword').value = '';
    document.getElementById('ownNewPassword').value = '';
    document.getElementById('ownConfirmPassword').value = '';
    showModal('changeOwnPasswordModal');
}

async function handleChangeOwnPassword() {
    const currentPassword = document.getElementById('ownCurrentPassword').value;
    const newPassword = document.getElementById('ownNewPassword').value;
    const confirmPassword = document.getElementById('ownConfirmPassword').value;
    const btn = document.getElementById('confirmOwnPasswordBtn');

    if (!currentPassword) {
        showToast('Ingresá tu contraseña actual', 'error');
        return;
    }
    if (!newPassword || newPassword.length < 6) {
        showToast('La nueva contraseña debe tener al menos 6 caracteres', 'error');
        return;
    }
    if (newPassword !== confirmPassword) {
        showToast('Las contraseñas no coinciden', 'error');
        return;
    }

    setButtonLoading(btn, true, 'Cambiando...');
    try {
        const response = await fetch(`${API_URL}/api/admin/change-own-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Error al cambiar contraseña');
        showToast('✅ Contraseña cambiada correctamente', 'success');
        hideModal('changeOwnPasswordModal');
    } catch (error) {
        showToast(error.message || 'Error al cambiar contraseña', 'error');
    } finally {
        setButtonLoading(btn, false, '🔑 Cambiar contraseña');
    }
}

window.showChangeOwnPasswordModal = showChangeOwnPasswordModal;
window.handleChangeOwnPassword = handleChangeOwnPassword;

// ============================================
// SMS MASIVO PANEL
// ============================================

// Códigos de país LATAM válidos (espejo del listado de server.js)
const SMS_VALID_COUNTRY_CODES = [
    '+54', '+591', '+55', '+56', '+57', '+506', '+53', '+593',
    '+503', '+502', '+504', '+52', '+505', '+507', '+595', '+51', '+1', '+598', '+58'
];

const SMS_FAKE_PATTERN = /^(\d)\1+$|^1234567890$|^0987654321$|^12345678$|^01234567$/;

const SMS_COSTO_POR_MENSAJE = 0.006;

function smsValidarTelefono(phone) {
    if (!phone || typeof phone !== 'string') return { valid: false, reason: 'Número ausente o inválido' };
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8) return { valid: false, reason: 'Menos de 8 dígitos' };
    if (digits.length > 15) return { valid: false, reason: 'Más de 15 dígitos' };
    if (SMS_FAKE_PATTERN.test(digits)) return { valid: false, reason: 'Patrón falso o de prueba' };
    const hasValidPrefix = SMS_VALID_COUNTRY_CODES.some(code => phone.startsWith(code));
    if (!hasValidPrefix) return { valid: false, reason: 'Prefijo de país no reconocido' };
    return { valid: true };
}

function actualizarContadorSms() {
    const textarea = document.getElementById('smsMensaje');
    const counter = document.getElementById('smsContadorNum');
    if (!textarea || !counter) return;
    const remaining = 160 - textarea.value.length;
    counter.textContent = remaining;
    counter.style.color = remaining < 20 ? '#ef4444' : remaining < 40 ? '#f59e0b' : '#86efac';
}

async function previewSmsMasivo() {
    const mensaje = (document.getElementById('smsMensaje')?.value || '').trim();
    if (!mensaje) {
        showToast('Escribí el mensaje SMS antes de ver los destinatarios', 'error');
        return;
    }
    if (mensaje.length > 160) {
        showToast('El mensaje supera los 160 caracteres', 'error');
        return;
    }

    const btn = document.getElementById('smsPreviewBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Cargando...'; }

    // Ocultar resultados anteriores
    const panelPreview = document.getElementById('smsPreviewPanel');
    const panelResultados = document.getElementById('smsResultados');
    if (panelPreview) panelPreview.style.display = 'none';
    if (panelResultados) panelResultados.style.display = 'none';

    try {
        const filters = obtenerFiltrosSms();
        const onlyVerified = document.getElementById('bulkSmsOnlyVerified')?.checked === true;
        const res = await fetch(`${API_URL}/api/admin/bulk-sms/preview`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ filters, onlyVerified })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error al cargar destinatarios');

        renderSmsPreview(data);
        if (panelPreview) panelPreview.style.display = '';
    } catch (error) {
        showToast(error.message || 'Error al cargar destinatarios', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔍 Ver destinatarios'; }
    }
}

function obtenerFiltrosSms() {
    const filtros = {};
    if (document.getElementById('smsFiltroConsentimiento')?.checked) filtros.smsConsent = true;
    if (document.getElementById('smsFiltroActivos')?.checked) filtros.isActive = true;
    return filtros;
}

function renderSmsPreview(data) {
    const resumen = document.getElementById('smsPreviewResumen');
    const tabla = document.getElementById('smsPreviewTabla');
    const costo = document.getElementById('smsEstimadoCosto');
    const sendBtn = document.getElementById('smsSendBtn');

    if (resumen) {
        resumen.innerHTML = `
            <div style="background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.3);border-radius:8px;padding:.6rem 1rem;font-size:.9rem;">
                📦 Total en DB: <strong>${data.total}</strong>
            </div>
            <div style="background:rgba(16,185,129,.15);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:.6rem 1rem;font-size:.9rem;color:#86efac;">
                ✅ Válidos: <strong>${data.valid}</strong>
            </div>
            <div style="background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:.6rem 1rem;font-size:.9rem;color:#fca5a5;">
                ❌ Descartados: <strong>${data.invalid}</strong>
            </div>
        `;
    }

    if (costo) {
        const estimado = (data.valid * SMS_COSTO_POR_MENSAJE).toFixed(2);
        costo.textContent = `Costo estimado: ~$${estimado} USD`;
    }

    if (sendBtn) {
        sendBtn.disabled = data.valid === 0;
    }

    if (tabla) {
        if (!data.recipients || data.recipients.length === 0) {
            tabla.innerHTML = '<tr><td colspan="3" style="padding:.8rem;text-align:center;color:#888;">Sin destinatarios</td></tr>';
            return;
        }
        tabla.innerHTML = data.recipients.map(r => `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                <td style="padding:.5rem .8rem;">${escapeHtml(r.username)}</td>
                <td style="padding:.5rem .8rem;font-family:monospace;font-size:.8rem;">${escapeHtml(r.phone || '-')}</td>
                <td style="padding:.5rem .8rem;">
                    ${r.valid
                        ? '<span style="color:#86efac;">✅ Válido</span>'
                        : `<span style="color:#fca5a5;">❌ ${escapeHtml(r.reason || 'Inválido')}</span>`}
                </td>
            </tr>
        `).join('');
    }
}

function confirmarEnvioSmsMasivo() {
    const mensaje = (document.getElementById('smsMensaje')?.value || '').trim();
    if (!mensaje) { showToast('El mensaje está vacío', 'error'); return; }

    const resumenEl = document.getElementById('smsPreviewResumen');
    const validMatch = resumenEl ? resumenEl.textContent.match(/Válidos:\s*(\d+)/) : null;
    const totalMatch = resumenEl ? resumenEl.textContent.match(/Total en DB:\s*(\d+)/) : null;
    const validCount = validMatch ? parseInt(validMatch[1], 10) : 0;
    const totalCount = totalMatch ? parseInt(totalMatch[1], 10) : validCount;

    if (validCount === 0) { showToast('No hay destinatarios válidos para enviar', 'error'); return; }

    const estimado = (validCount * SMS_COSTO_POR_MENSAJE).toFixed(2);
    const onlyVerified = document.getElementById('bulkSmsOnlyVerified')?.checked === true;

    let confirmMsg;
    if (!onlyVerified) {
        confirmMsg = `⚠️ Vas a enviar SMS a TODOS los usuarios con teléfono cargado, incluyendo los que NO verificaron su número.\n\n` +
            `Esto puede:\n` +
            `- Generar SMS fallidos a números inválidos.\n` +
            `- Llegar a usuarios que no dieron consentimiento explícito.\n\n` +
            `Total en DB: ${totalCount} | Válidos: ${validCount}\n` +
            `Costo estimado (sobre válidos): $${estimado} USD\n\n` +
            `¿Continuar?`;
    } else {
        confirmMsg = `¿Estás seguro?\n\nSe enviarán ${validCount} SMS.\nCosto estimado: $${estimado} USD\n\nEsta acción no se puede deshacer.`;
    }

    if (!confirm(confirmMsg)) return;

    enviarSmsMasivo(mensaje);
}

async function enviarSmsMasivo(mensaje) {
    const sendBtn = document.getElementById('smsSendBtn');
    const previewBtn = document.getElementById('smsPreviewBtn');
    const progreso = document.getElementById('smsProgreso');
    const progresoTexto = document.getElementById('smsProgresoTexto');
    const previewPanel = document.getElementById('smsPreviewPanel');
    const resultados = document.getElementById('smsResultados');

    if (sendBtn) { sendBtn.disabled = true; }
    if (previewBtn) { previewBtn.disabled = true; }
    if (progreso) { progreso.style.display = ''; }
    if (progresoTexto) { progresoTexto.textContent = 'Enviando SMS masivo... (esto puede demorar varios minutos)'; }
    if (previewPanel) previewPanel.style.display = 'none';
    if (resultados) resultados.style.display = 'none';

    try {
        const filters = obtenerFiltrosSms();
        const onlyVerified = document.getElementById('bulkSmsOnlyVerified')?.checked === true;
        const res = await fetch(`${API_URL}/api/admin/bulk-sms`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ message: mensaje, filters, onlyVerified })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error al enviar SMS masivo');

        if (progreso) progreso.style.display = 'none';
        renderSmsResultados(data);
        if (resultados) resultados.style.display = '';

        showToast(`✅ Enviados: ${data.sent} | ⚠️ Saltados (teléfono inválido): ${data.discarded || 0} | ❌ Errores: ${data.failed}`, 'success');
    } catch (error) {
        if (progreso) progreso.style.display = 'none';
        showToast(error.message || 'Error al enviar SMS masivo', 'error');
        if (sendBtn) sendBtn.disabled = false;
        if (previewPanel) previewPanel.style.display = '';
    } finally {
        if (previewBtn) previewBtn.disabled = false;
    }
}

function renderSmsResultados(data) {
    const resumen = document.getElementById('smsResultadosResumen');
    const tabla = document.getElementById('smsResultadosTabla');

    if (resumen) {
        resumen.innerHTML = `
            <div style="background:rgba(16,185,129,.15);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:.6rem 1rem;font-size:.9rem;color:#86efac;">
                ✅ Enviados: <strong>${data.sent}</strong>
            </div>
            <div style="background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:.6rem 1rem;font-size:.9rem;color:#fca5a5;">
                ❌ Fallidos: <strong>${data.failed}</strong>
            </div>
            <div style="background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.3);border-radius:8px;padding:.6rem 1rem;font-size:.9rem;color:#fcd34d;">
                ⚠️ Descartados: <strong>${data.discarded || 0}</strong>
            </div>
            <div style="background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.3);border-radius:8px;padding:.6rem 1rem;font-size:.9rem;">
                📦 Total: <strong>${data.total}</strong>
            </div>
        `;
    }

    if (tabla) {
        if (!data.results || data.results.length === 0) {
            tabla.innerHTML = '<tr><td colspan="4" style="padding:.8rem;text-align:center;color:#888;">Sin resultados</td></tr>';
            return;
        }
        tabla.innerHTML = data.results.map(r => {
            let statusHtml;
            if (r.status === 'sent') {
                statusHtml = '<span style="color:#86efac;">✅ Enviado</span>';
            } else if (r.status === 'discarded') {
                statusHtml = '<span style="color:#fcd34d;">⚠️ Descartado</span>';
            } else {
                statusHtml = '<span style="color:#fca5a5;">❌ Fallido</span>';
            }
            const detalle = r.error || r.reason || '-';
            return `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:.5rem .8rem;">${escapeHtml(r.username)}</td>
                    <td style="padding:.5rem .8rem;font-family:monospace;font-size:.8rem;">${escapeHtml(r.phone || '-')}</td>
                    <td style="padding:.5rem .8rem;">${statusHtml}</td>
                    <td style="padding:.5rem .8rem;font-size:.8rem;color:#aaa;">${escapeHtml(detalle)}</td>
                </tr>
            `;
        }).join('');
    }
}

function reiniciarSmsMasivo() {
    const ids = ['smsPreviewPanel', 'smsProgreso', 'smsResultados'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const textarea = document.getElementById('smsMensaje');
    if (textarea) textarea.value = '';
    actualizarContadorSms();
    const sendBtn = document.getElementById('smsSendBtn');
    if (sendBtn) sendBtn.disabled = false;
    const previewBtn = document.getElementById('smsPreviewBtn');
    if (previewBtn) previewBtn.disabled = false;
}

window.actualizarContadorSms = actualizarContadorSms;
window.previewSmsMasivo = previewSmsMasivo;
window.confirmarEnvioSmsMasivo = confirmarEnvioSmsMasivo;
window.reiniciarSmsMasivo = reiniciarSmsMasivo;

