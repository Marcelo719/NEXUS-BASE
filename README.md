# NEXUS Starter
### LA APP QUE SIMPLIFICA TODO
*Todos tus chats y tu correo, en tu WhatsApp*

---

## ¿Qué es?

NEXUS Starter centraliza en una sola bandeja unificada los mensajes de **WhatsApp Business**, **Instagram DMs** y **correo electrónico** (Gmail, Outlook). Todo lo operativo llega a tu WhatsApp como mensajes normales.

## Stack

- **Servidor:** Node.js + Express
- **Base de datos:** Supabase (PostgreSQL)
- **IA rápida:** Claude Haiku (`claude-haiku-4-5-20251001`)
- **IA avanzada:** Claude Sonnet (`claude-sonnet-4-6`)
- **Texto a voz:** ElevenLabs — voz Rachel
- **Canales:** WhatsApp Business API + Instagram DMs + Gmail API + Outlook Graph API
- **Calendario:** Google Calendar API v3
- **Deploy:** Vercel o Railway

## Instalación

```bash
git clone <repo-privado>
cd SUBIR
npm install
cp .env.example .env.local
# Completar todas las variables en .env.local
```

## Configuración paso a paso

### 1. Supabase
1. Crear proyecto en [supabase.com](https://supabase.com)
2. Ejecutar `supabase/schema.sql` en el SQL Editor
3. Crear buckets de Storage: `nexus-audios` (Privado) y `nexus-exports` (Privado)
4. Copiar URL y Service Role Key al `.env.local`

### 2. Meta (WhatsApp + Instagram)
1. Crear app en [Meta for Developers](https://developers.facebook.com)
2. Agregar producto WhatsApp Business
3. Agregar producto Instagram Basic Display / Messenger
4. Configurar webhook: `https://tu-app.vercel.app/api/webhook`
5. Verify token = valor de `WHATSAPP_TOKEN` en tu `.env`
6. Suscribirse a: `messages`, `message_deliveries`, `message_reads`

### 3. Google (Gmail + Calendar)
1. Crear proyecto en [Google Cloud Console](https://console.cloud.google.com)
2. Habilitar APIs: Gmail API v1, Google Calendar API v3
3. Crear credenciales OAuth 2.0 (tipo: Web application)
4. Agregar redirect URIs:
   - `https://tu-app.vercel.app/api/auth/gmail/callback`
   - `https://tu-app.vercel.app/api/calendar/callback`

### 4. Azure (Outlook)
1. Registrar app en [Azure Portal](https://portal.azure.com) → App registrations
2. Agregar redirect URI: `https://tu-app.vercel.app/api/auth/outlook/callback`
3. Crear client secret

### 5. Deploy en Vercel
```bash
vercel deploy
# Cargar todas las variables de .env.local en Vercel Dashboard → Settings → Environment Variables
```

### 6. VAPID Keys para push notifications
```bash
npx web-push generate-vapid-keys
# Pegar VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY en las variables de entorno
```

### 7. Primer usuario en Supabase
```sql
INSERT INTO users (nombre, email, whatsapp_num)
VALUES ('Tu Nombre', 'tu@email.com', '5491112345678');
-- Copiar el UUID generado a NEXUS_USER_ID en .env
```

## Comandos disponibles (por WhatsApp)

| Comando | Acción |
|---------|--------|
| `resumen [nombre]` | Resumen en texto de la conversación |
| `audio [nombre]` | Resumen narrado en audio |
| `retomar [nombre]` | Mensaje de reapertura con IA |
| `pendientes` | Ver seguimientos activos |
| `ver notas [nombre]` | Ver notas y etiquetas |
| `nota [nombre]: [texto]` | Agregar nota manual |
| `etiqueta [nombre]: [tag]` | Agregar etiqueta |
| `quitar etiqueta [nombre]: [tag]` | Eliminar etiqueta |
| `reporte` | Reporte semanal (ahora) |
| `exportar contactos` | CSV con toda la base |
| `modo auto/parcial/manual` | Cambiar modo de automatización |
| `estado` | Verificar conexiones |
| `SÍ / SI` | Confirmar acción pendiente |
| `ENVIAR / OK` | Enviar mensaje sugerido |
| `IGNORAR / NO` | Descartar acción |
| `EDITAR [texto]` | Modificar y enviar |
| `ayuda` | Ver todos los comandos |

## Seguridad

- Solo `OWNER_WA_ID` puede ejecutar comandos
- Firma HMAC-SHA256 verificada en cada webhook
- API keys solo en variables de entorno
- Repo debe ser **PRIVADO** en GitHub

## Licencia

Proyecto privado. No distribuir.
