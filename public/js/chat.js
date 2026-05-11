// ========================================
// CHAT - Messaging module
// ========================================

window.VIP = window.VIP || {};

VIP.chat = (function () {

    // ---- Helpers ----

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function scrollToBottom() {
        const container = document.getElementById('chatMessages');
        if (container) {
            container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
            container.scrollTop = container.scrollHeight;
        }
    }

    // ---- Lightbox ----

    function openLightbox(src) {
        const lightbox = document.getElementById('lightbox');
        const lightboxImage = document.getElementById('lightboxImage');
        lightboxImage.src = src;
        lightbox.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function closeLightbox(event) {
        if (event.target.id === 'lightbox' || event.target.classList.contains('lightbox-close')) {
            const lightbox = document.getElementById('lightbox');
            lightbox.classList.remove('active');
            document.body.style.overflow = '';
        }
    }

    // ---- Message rendering ----

    function createMessageElement(message) {
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
        let imageUrl = null;
        if (message.type === 'image') {
            imageUrl = encodeURI(message.content);
            contentHtml = `<img src="${imageUrl}" loading="lazy" style="cursor:pointer;">`;
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

        if (imageUrl) {
            const img = msgDiv.querySelector('img');
            if (img) {
                img.addEventListener('click', function() {
                    openLightbox(imageUrl);
                });
            }
        }

        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.innerHTML = '📋';
        copyBtn.onclick = () => VIP.ui.copyText(
            message.type === 'image' ? '[Imagen]' :
            message.type === 'video' ? '[Video]' :
            message.content
        );

        wrapper.appendChild(msgDiv);
        wrapper.appendChild(copyBtn);
        return wrapper;
    }

    function addMessageToChat(message) {
        const container = document.getElementById('chatMessages');

        if (message.id) {
            const existingById = container.querySelector(`[data-message-id="${message.id}"]`);
            if (existingById) return;

            const existingByTemp = container.querySelector(`[data-temp-id="${message.id}"]`);
            if (existingByTemp) {
                existingByTemp.setAttribute('data-message-id', message.id);
                existingByTemp.removeAttribute('data-temp-id');
                return;
            }
        }

        const wrapper = createMessageElement(message);
        container.appendChild(wrapper);
        requestAnimationFrame(() => scrollToBottom());
    }

    function getDateLabel(dateStr) {
        const msgDate = new Date(dateStr);
        const today = getArgentinaDate();
        const yesterday = getArgentinaDate();
        yesterday.setDate(yesterday.getDate() - 1);

        const msgDay = msgDate.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        const todayStr = today.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        const yesterdayStr = yesterday.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

        if (msgDay === todayStr) return 'Hoy';
        if (msgDay === yesterdayStr) return 'Ayer';

        return msgDate.toLocaleDateString('es-AR', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            timeZone: 'America/Argentina/Buenos_Aires'
        });
    }

    function createDateSeparator(label) {
        const sep = document.createElement('div');
        sep.className = 'chat-date-separator';
        sep.innerHTML = `<span>${label}</span>`;
        return sep;
    }

    function renderMessages(messages) {
        const container = document.getElementById('chatMessages');
        const isInitialLoad = VIP.state.lastMessagesHash === '';
        const wasAtBottom = isInitialLoad || (container.scrollHeight - container.scrollTop - container.clientHeight) < 60;

        const fragment = document.createDocumentFragment();
        VIP.state.processedMessageIds.clear();

        let lastDateLabel = '';
        messages.forEach(msg => {
            if (msg.id) VIP.state.processedMessageIds.add(msg.id);
            const dateLabel = getDateLabel(msg.timestamp);
            if (dateLabel !== lastDateLabel) {
                fragment.appendChild(createDateSeparator(dateLabel));
                lastDateLabel = dateLabel;
            }
            const wrapper = createMessageElement(msg);
            if (wrapper) fragment.appendChild(wrapper);
        });

        container.innerHTML = '';
        container.appendChild(fragment);

        if (messages.length > 0) {
            const lastMsg = messages[messages.length - 1];
            const adminRoles = ['admin', 'depositor', 'withdrawer'];
            if (VIP.state.lastMessageId && VIP.state.lastMessageId !== lastMsg.id && adminRoles.includes(lastMsg.senderRole)) {
                VIP.notifications.playNotificationSound();
            }
            VIP.state.lastMessageId = lastMsg.id;
        }

        if (wasAtBottom) {
            requestAnimationFrame(() => scrollToBottom());
        }
    }

    async function loadMessages(force = false) {
        if (VIP.state.isLoadingMessages && !force) return;
        if (!VIP.state.currentUser || !VIP.state.currentUser.userId) return;

        VIP.state.isLoadingMessages = true;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            console.log('[loadMessages] Cargando mensajes para:', VIP.state.currentUser.userId);

            const response = await fetch(
                `${VIP.config.API_URL}/api/messages/${VIP.state.currentUser.userId}?limit=15`,
                {
                    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` },
                    signal: controller.signal
                }
            );
            clearTimeout(timeoutId);

            if (response.ok) {
                const data = await response.json();
                const messages = data.messages || [];

                console.log('[loadMessages] Mensajes recibidos:', messages.length);
                if (messages.length > 0) {
                    console.log('[loadMessages] Primer mensaje:', messages[0].content.substring(0, 30));
                    console.log('[loadMessages] Último mensaje:', messages[messages.length - 1].content.substring(0, 30));
                }

                const messagesHash = messages.map(m => m.id).join(',');
                if (messagesHash !== VIP.state.lastMessagesHash || force) {
                    VIP.state.lastMessagesHash = messagesHash;
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
            VIP.state.isLoadingMessages = false;
        }
    }

    async function sendMessage() {
        const input = document.getElementById('messageInput');
        const content = input.value.trim();

        if (!content) return;

        if (content.startsWith('/')) {
            VIP.ui.showToast('No puedes enviar comandos', 'error');
            input.value = '';
            input.style.height = 'auto';
            return;
        }

        const now = Date.now();
        const recentTimestamps = VIP.state.sentMessageTimestamps.filter(
            t => now - t < VIP.config.FRONTEND_MSG_RATE_WINDOW_MS
        );
        if (recentTimestamps.length >= VIP.config.FRONTEND_MSG_RATE_MAX) {
            VIP.ui.showToast('Estás enviando mensajes muy rápido. Esperá un momento.', 'info');
            input.value = '';
            input.style.height = 'auto';
            return;
        }
        VIP.state.sentMessageTimestamps.length = 0;
        VIP.state.sentMessageTimestamps.push(...recentTimestamps, now);

        if (now - VIP.state.lastSentMessageTimestamp < 3000) {
            const recentContent = VIP.state.pendingSentMessages.get(content);
            if (recentContent && (now - recentContent) < 3000) {
                input.value = '';
                input.style.height = 'auto';
                return;
            }
        }
        VIP.state.pendingSentMessages.set(content, now);

        for (const [msg, timestamp] of VIP.state.pendingSentMessages.entries()) {
            if (now - timestamp > 10000) {
                VIP.state.pendingSentMessages.delete(msg);
            }
        }

        const tempId = 'temp-' + now;
        const tempMessage = {
            id: tempId,
            senderId: VIP.state.currentUser.userId,
            senderUsername: VIP.state.currentUser.username,
            senderRole: 'user',
            content: content,
            type: 'text',
            timestamp: new Date().toISOString()
        };
        addMessageToChat(tempMessage);

        input.value = '';
        input.style.height = 'auto';

        scrollToBottom();
        setTimeout(scrollToBottom, 100);
        setTimeout(scrollToBottom, 300);

        if (VIP.state.socket && VIP.state.socket.connected) {
            console.log('📤 Enviando mensaje por socket...');
            VIP.state.socket.emit('send_message', { content, type: 'text' });
            return;
        }

        console.log('📤 Enviando mensaje por REST API...');
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/messages/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify({ content, type: 'text' })
            });

            if (response.ok) {
                const savedMessage = await response.json();
                console.log('✅ Mensaje guardado:', savedMessage);
                const tempMsgElement = document.querySelector(`[data-temp-id="${tempId}"]`);
                if (tempMsgElement) {
                    tempMsgElement.setAttribute('data-message-id', savedMessage.id);
                    tempMsgElement.removeAttribute('data-temp-id');
                    tempMsgElement.classList.add('message-saved');
                }
                scrollToBottom();
            } else {
                const tempMsgElement = document.querySelector(`[data-temp-id="${tempId}"]`);
                if (tempMsgElement) {
                    tempMsgElement.classList.add('message-error');
                    const msgDiv = tempMsgElement.querySelector('.message');
                    if (msgDiv) { msgDiv.style.opacity = '0.5'; msgDiv.style.border = '1px solid #ff4444'; }
                }
                VIP.ui.showToast('Error al enviar mensaje', 'error');
            }
        } catch (error) {
            console.error('❌ Error enviando mensaje:', error);
            const tempMsgElement = document.querySelector(`[data-temp-id="${tempId}"]`);
            if (tempMsgElement) {
                tempMsgElement.classList.add('message-error');
                const msgDiv = tempMsgElement.querySelector('.message');
                if (msgDiv) { msgDiv.style.opacity = '0.5'; msgDiv.style.border = '1px solid #ff4444'; }
            }
            VIP.ui.showToast('Error de conexión', 'error');
        }
    }

    function compressImage(file, { maxDim = 1600, quality = 0.85 } = {}) {
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

    function readAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
            reader.readAsDataURL(file);
        });
    }

    function removeTempMessage(tempId) {
        const el = document.querySelector(`[data-temp-id="${tempId}"]`);
        if (el) el.remove();
    }

    async function parseErrorMessage(response, fallback) {
        try {
            const body = await response.json();
            if (body && body.error) return body.error;
        } catch (_) {}
        return fallback || `Error ${response.status}`;
    }

    async function sendMediaMessage({ dataUrl, fileType, fileLabel, tempId }) {
        const tempMessage = {
            id: tempId,
            senderId: VIP.state.currentUser?.id || 'me',
            senderUsername: VIP.state.currentUser?.username || 'Yo',
            senderRole: 'user',
            content: dataUrl,
            timestamp: new Date(),
            type: fileType
        };
        addMessageToChat(tempMessage);
        scrollToBottom();

        const response = await fetch(`${VIP.config.API_URL}/api/messages/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${VIP.state.currentToken}`
            },
            body: JSON.stringify({ content: dataUrl, type: fileType })
        });

        if (!response.ok) {
            removeTempMessage(tempId);
            const errMsg = await parseErrorMessage(response, `No se pudo enviar ${fileLabel.toLowerCase()}`);
            VIP.ui.showToast(`${fileLabel}: ${errMsg}`, 'error');
            return false;
        }

        loadMessages();
        VIP.ui.showToast(`${fileLabel} enviada`, 'success');
        return true;
    }

    async function handleFileSelect(e) {
        const file = e.target.files[0];
        if (!file) return;

        const isImage = file.type.startsWith('image/');
        const isVideo = file.type.startsWith('video/');
        if (!isImage && !isVideo) {
            VIP.ui.showToast('Solo se permiten imágenes o videos', 'error');
            e.target.value = '';
            return;
        }
        if (isImage && file.size > 30 * 1024 * 1024) {
            VIP.ui.showToast('La imagen es muy grande. Máximo 30 MB', 'error');
            e.target.value = '';
            return;
        }
        if (isVideo && file.size > 3.5 * 1024 * 1024) {
            VIP.ui.showToast('El video es muy grande. Máximo 3.5 MB', 'error');
            e.target.value = '';
            return;
        }

        const fileType = isVideo ? 'video' : 'image';
        const fileLabel = isVideo ? '🎥 Video' : '📸 Imagen';
        const tempId = 'temp-' + fileType + '-' + Date.now();

        const sendingIndicator = document.getElementById('sendingIndicator');
        if (sendingIndicator) sendingIndicator.style.display = 'block';

        try {
            const dataUrl = isImage
                ? await compressImage(file)
                : await readAsDataUrl(file);

            await sendMediaMessage({ dataUrl, fileType, fileLabel, tempId });
        } catch (error) {
            console.error('Error enviando archivo:', error);
            removeTempMessage(tempId);
            VIP.ui.showToast(`Error al enviar ${fileLabel.toLowerCase()}`, 'error');
        } finally {
            if (sendingIndicator) sendingIndicator.style.display = 'none';
            e.target.value = '';
        }
    }

    async function handlePaste(e) {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;

        for (const item of items) {
            if (!item.type.startsWith('image/')) continue;
            e.preventDefault();
            const file = item.getAsFile();
            if (!file) continue;

            if (file.size > 30 * 1024 * 1024) {
                VIP.ui.showToast('La imagen es muy grande. Máximo 30 MB', 'error');
                return;
            }

            const tempId = 'temp-image-' + Date.now();
            const sendingIndicator = document.getElementById('sendingIndicator');
            if (sendingIndicator) sendingIndicator.style.display = 'block';

            try {
                const dataUrl = await compressImage(file);
                await sendMediaMessage({ dataUrl, fileType: 'image', fileLabel: '📸 Imagen', tempId });
            } catch (error) {
                console.error('Error enviando imagen pegada:', error);
                removeTempMessage(tempId);
                VIP.ui.showToast('Error al enviar imagen', 'error');
            } finally {
                if (sendingIndicator) sendingIndicator.style.display = 'none';
            }
            break;
        }
    }

    async function sendSystemMessage(content) {
        try {
            await fetch(`${VIP.config.API_URL}/api/messages/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify({ content: content, type: 'text' })
            });
            setTimeout(() => loadMessages(), 200);
        } catch (error) {
            console.error('Error enviando mensaje de sistema:', error);
        }
    }

    async function loadCanalInformativoUrl() {
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/config/canal-url`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
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
            const btn = document.getElementById('canalInformativoBtn');
            if (btn) btn.style.display = 'none';
        }
    }

    return {
        escapeHtml,
        scrollToBottom,
        openLightbox,
        closeLightbox,
        createMessageElement,
        addMessageToChat,
        renderMessages,
        loadMessages,
        sendMessage,
        handleFileSelect,
        handlePaste,
        sendSystemMessage,
        loadCanalInformativoUrl
    };

})();

// Window aliases required for onclick="..." in HTML and in createMessageElement
window.openLightbox  = VIP.chat.openLightbox;
window.closeLightbox = VIP.chat.closeLightbox;
window.sendMessage   = VIP.chat.sendMessage;
