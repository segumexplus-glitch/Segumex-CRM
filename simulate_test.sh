#!/bin/bash

# URL de tu Webhook
WEBHOOK_URL="https://mmhdpbygdvdyujiktvqa.supabase.co/functions/v1/webhook-meta"

# ID de Teléfono de Negocio (El que configuramos)
PHONE_ID="918776421326775"

# Tu número personal (El que viste en la captura)
# NOTA: En WhatsApp API los números no llevan el '+'
USER_PHONE="524494296226"

echo "📡 Enviando mensaje SIMULADO al Webhook..."
echo "URL: $WEBHOOK_URL"
echo "PHONE_ID: $PHONE_ID"
echo "FROM: $USER_PHONE"

curl -X POST "$WEBHOOK_URL" \
-H 'Content-Type: application/json' \
-d "{
  \"object\": \"whatsapp_business_account\",
  \"entry\": [{
    \"id\": \"123456789\",
    \"changes\": [{
      \"value\": {
        \"messaging_product\": \"whatsapp\",
        \"metadata\": {
          \"display_phone_number\": \"15551763286\",
          \"phone_number_id\": \"$PHONE_ID\"
        },
        \"contacts\": [{
          \"profile\": {
            \"name\": \"Alejandro Test\"
          },
          \"wa_id\": \"$USER_PHONE\"
        }],
        \"messages\": [{
          \"from\": \"$USER_PHONE\",
          \"id\": \"wamid.test.$(date +%s)\",
          \"timestamp\": \"$(date +%s)\",
          \"text\": {
            \"body\": \"Hola Simulado desde Terminal\"
          },
          \"type\": \"text\"
        }]
      },
      \"field\": \"messages\"
    }]
  }]
}"

echo ""
echo "✅ Mensaje enviado. Revisa los logs de Supabase ahora."
