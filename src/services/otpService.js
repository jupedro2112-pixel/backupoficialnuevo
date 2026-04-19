
/**
 * Servicio OTP - One-Time Password
 * Gestiona generación, envío y verificación de códigos OTP para:
 * - Verificación de teléfono en el registro ('register')
 * - Reset de contraseña por SMS ('reset')
 * - Verificación del nuevo teléfono al cambiar contraseña ('change-password')
 * - Login por SMS ('login')
 *
 * FALLBACK DEFENSIVO (OTP_FALLBACK_SHOW_ON_FAIL):
 * Si esta variable de entorno es 'true' y AWS SNS devuelve error al enviar el SMS,
 * se devuelve el código OTP en la respuesta HTTP SÓLO para purposes no sensibles:
 *   - 'register'         -> nuevo usuario, no existe cuenta a tomar
 *   - 'change-password'  -> verificación de teléfono nuevo
 * NUNCA se activa para 'reset' o 'login' (flujos sensibles que podrían permitir
 * toma de cuentas ajenas si el código se expone).
 * Ver requerimientos completos en el issue de implementación.
 */

const bcrypt = require('bcryptjs');
const OtpCode = require('../models/OtpCode');
const OtpFallbackUsage = require('../models/OtpFallbackUsage');
const { sendSMS } = require('./smsService');
const logger = require('../utils/logger');

const OTP_LENGTH = 6;
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_SECONDS = 60;    // No reenviar si hay OTP válido creado hace menos de 60 segundos
const MAX_OTPS_PER_HOUR = 3;      // Máximo 3 OTPs por número por hora

// Purposes para los que el fallback está PERMITIDO (no sensibles).
// NUNCA incluir 'reset' ni 'login'.
const FALLBACK_ALLOWED_PURPOSES = ['register', 'change-password'];

// Rate limit del fallback: máximo 2 usos por IP por hora.
const MAX_FALLBACK_PER_IP_PER_HOUR = 2;

// Máximo de caracteres a guardar del mensaje de error de SNS en la colección de auditoría.
const MAX_SNS_ERROR_LENGTH = 300;

// Contador en memoria: Map<ip, timestamp[]> de usos del fallback en la última hora.
// NOTA: Este contador se pierde al reiniciar el servidor. Es una protección de "buena fe"
// suficiente dado que el fallback es temporal y el rate limit principal es MAX_OTPS_PER_HOUR.
// Si se requiere persistencia, migrar a Redis o a la colección OtpFallbackUsage.
const _fallbackIpUsage = new Map();

/**
 * Devuelve los timestamps de usos de fallback de la IP en la última hora,
 * limpiando los que ya expiraron.
 */
function _getFallbackUsageForIp(ip) {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const times = (_fallbackIpUsage.get(ip) || []).filter(t => t > oneHourAgo);
  _fallbackIpUsage.set(ip, times);
  return times;
}

/**
 * Enmascara un número de teléfono dejando solo el prefijo internacional
 * y los últimos 4 dígitos visibles (ej: +549********5678).
 */
function maskPhone(phone) {
  if (!phone || phone.length < 5) return phone;
  const match = phone.match(/^(\+\d{1,4})(\d+)(\d{4})$/);
  if (match) return match[1] + '*'.repeat(match[2].length) + match[3];
  return phone.slice(0, 3) + '*'.repeat(Math.max(0, phone.length - 7)) + phone.slice(-4);
}

/**
 * Genera un código OTP numérico de 6 dígitos.
 * @returns {string} código de 6 dígitos como string
 */
function generateCode() {
  const num = Math.floor(Math.random() * 1000000);
  return String(num).padStart(OTP_LENGTH, '0');
}

/**
 * Genera un OTP, lo hashea, lo guarda en DB y lo envía por SMS.
 * Rate limit: no envía si ya hay un OTP válido para ese phone+purpose creado hace menos de 60s.
 * Máximo 3 OTPs por número por hora.
 *
 * @param {string} phone   - Teléfono normalizado (ej: +5491155551234)
 * @param {string} purpose - 'register' | 'reset' | 'login' | 'change-password'
 * @param {string} [ip]    - IP del cliente (req.ip). Opcional; usado para rate-limit del fallback.
 * @returns {Promise<{success: boolean, error?: string, smsSent?: boolean, fallbackCode?: string, fallbackReason?: string}>}
 */
async function generateAndSendOTP(phone, purpose, ip = null) {
  const now = new Date();

  // Rate limit: no reenviar si hay un OTP válido reciente (menos de 60 segundos)
  const recentOtp = await OtpCode.findOne({
    phone,
    purpose,
    createdAt: { $gte: new Date(now.getTime() - RATE_LIMIT_SECONDS * 1000) }
  });

  if (recentOtp) {
    return {
      success: false,
      error: `Espera ${RATE_LIMIT_SECONDS} segundos antes de solicitar un nuevo código`
    };
  }

  // Rate limit: máximo 3 OTPs por número por hora
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const recentCount = await OtpCode.countDocuments({
    phone,
    purpose,
    createdAt: { $gte: oneHourAgo }
  });

  if (recentCount >= MAX_OTPS_PER_HOUR) {
    return {
      success: false,
      error: 'Demasiados intentos. Espera una hora antes de solicitar un nuevo código.'
    };
  }

  // Generar código y hashear
  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);

  // Eliminar OTPs anteriores del mismo phone+purpose para evitar acumulación
  await OtpCode.deleteMany({ phone, purpose });

  // Guardar en DB
  await OtpCode.create({ phone, codeHash, purpose });

  // Enviar SMS
  let message;
  if (purpose === 'register') {
    message = `VIPCARGAS - Tu código de verificación es: ${code}. Válido por 5 min. www.vipcargas.com`;
  } else if (purpose === 'reset') {
    message = `VIPCARGAS - Tu código para restablecer contraseña es: ${code}. Válido por 5 min. www.vipcargas.com`;
  } else if (purpose === 'change-password') {
    message = `VIPCARGAS - Tu código para verificar tu teléfono al cambiar la contraseña es: ${code}. Válido por 5 min. www.vipcargas.com`;
  } else if (purpose === 'login') {
    message = `VIPCARGAS - Tu código de inicio de sesión es: ${code}. Válido por 5 min. www.vipcargas.com`;
  } else {
    message = `VIPCARGAS - Tu código de verificación es: ${code}. Válido por 5 min. www.vipcargas.com`;
  }

  const smsResult = await sendSMS(phone, message);

  if (!smsResult.success) {
    if (smsResult.error === 'SMS service not configured') {
      return { success: false, error: 'El servicio de SMS no está configurado. Contacta al administrador.' };
    }

    // Error real de SNS. Verificar si el fallback está habilitado.
    const fallbackEnabled = process.env.OTP_FALLBACK_SHOW_ON_FAIL === 'true';
    const purposeAllowed = FALLBACK_ALLOWED_PURPOSES.includes(purpose);

    if (fallbackEnabled && purposeAllowed) {
      // Verificar rate limit de fallback por IP
      if (ip) {
        const usages = _getFallbackUsageForIp(ip);
        if (usages.length >= MAX_FALLBACK_PER_IP_PER_HOUR) {
          logger.warn(`[otpService] Fallback rate limit alcanzado. ip=${ip}, purpose=${purpose}, phone=${maskPhone(phone)}`);
          console.error('[otpService] Error enviando SMS OTP:', smsResult.error);
          return { success: false, error: 'No se pudo enviar el SMS. Intenta nuevamente.' };
        }
        usages.push(Date.now());
        _fallbackIpUsage.set(ip, usages);
      }

      // Log de auditoría
      logger.warn(`[otpService] FALLBACK OTP shown to client. purpose=${purpose}, phone=${maskPhone(phone)}, ip=${ip}, snsError=${smsResult.error}`);

      // Guardar en DB para auditoría (async, sin bloquear la respuesta)
      OtpFallbackUsage.create({
        phone,
        purpose,
        ip: ip || null,
        snsError: String(smsResult.error || 'unknown').slice(0, MAX_SNS_ERROR_LENGTH),
        createdAt: new Date()
      }).catch(err => {
        logger.error(`[otpService] Error guardando OtpFallbackUsage: ${err.message}`);
      });

      return {
        success: true,
        smsSent: false,
        fallbackCode: code,
        fallbackReason: 'sms_delivery_failed'
      };
    }

    // Fallback no habilitado o purpose sensible: comportamiento actual
    console.error('[otpService] Error enviando SMS OTP:', smsResult.error);
    return { success: false, error: 'No se pudo enviar el SMS. Intenta nuevamente.' };
  }

  return { success: true, smsSent: true };
}

/**
 * Verifica un código OTP contra el hash almacenado en DB.
 * Si attempts >= MAX_ATTEMPTS, invalida el código.
 *
 * @param {string} phone - Teléfono normalizado
 * @param {string} code - Código de 6 dígitos ingresado por el usuario
 * @param {string} purpose - 'register' o 'reset'
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
async function verifyOTP(phone, code, purpose) {
  const otp = await OtpCode.findOne({ phone, purpose });

  if (!otp) {
    return { valid: false, error: 'Código incorrecto o expirado' };
  }

  // Si ya se agotaron los intentos, invalidar
  if (otp.attempts >= MAX_ATTEMPTS) {
    await OtpCode.deleteOne({ _id: otp._id });
    return { valid: false, error: 'Código bloqueado por demasiados intentos incorrectos. Solicita uno nuevo.' };
  }

  const isValid = await bcrypt.compare(String(code).trim(), otp.codeHash);

  if (!isValid) {
    // Incrementar intentos
    await OtpCode.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
    const remaining = MAX_ATTEMPTS - (otp.attempts + 1);
    return {
      valid: false,
      error: remaining > 0
        ? `Código incorrecto. Te quedan ${remaining} intento(s).`
        : 'Código bloqueado por demasiados intentos incorrectos. Solicita uno nuevo.'
    };
  }

  // Código correcto: eliminar para que no pueda reutilizarse
  await OtpCode.deleteOne({ _id: otp._id });

  return { valid: true };
}

module.exports = { generateAndSendOTP, verifyOTP };
