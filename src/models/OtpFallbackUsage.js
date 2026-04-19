
/**
 * Modelo OtpFallbackUsage - Auditoría de usos del fallback OTP en pantalla.
 * Se guarda cada vez que el código OTP se devuelve en la respuesta HTTP
 * porque AWS SNS falló al enviar el SMS.
 *
 * IMPORTANTE: Este documento contiene el número de teléfono completo (sin enmascarar)
 * para permitir auditoría post-incidente. TTL de 30 días.
 *
 * Solo se crea cuando OTP_FALLBACK_SHOW_ON_FAIL=true y purpose ∈ ['register','change-password'].
 */
const mongoose = require('mongoose');

const otpFallbackUsageSchema = new mongoose.Schema({
  phone:    { type: String, required: true },
  purpose:  { type: String, required: true },
  ip:       { type: String, default: null },
  snsError: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 } // TTL: 30 días
});

module.exports = mongoose.model('OtpFallbackUsage', otpFallbackUsageSchema);
