#!/bin/bash

# Script de Configuración Automática - Segumex AI

echo "🚀 Iniciando configuración de Segumex AI..."

# 1. Configurar Secretos
echo "🔑 Configurando secretos en Supabase (usando npx)..."
npx -y supabase secrets set GREEN_INSTANCE_ID="7107490894"
npx -y supabase secrets set GREEN_API_TOKEN="1f5b3517ebf0423080eca6ce74892e5998ab500a7a2d41bcaa"
npx -y supabase secrets set GEMINI_API_KEY="AIzaSyBC6m1epX4wfj2vFq7B_b-B5INUuql92a0"

# 2. Desplegar Funciones
echo "☁️  Desplegando funciones (Edge Functions)..."
npx -y supabase functions deploy ai-brain --no-verify-jwt
npx -y supabase functions deploy webhook-greenapi --no-verify-jwt

echo "✅ ¡Configuración completada!"
echo "---------------------------------------------------"
echo "👉 PASO FINAL: Ve a tu Dashboard de Meta y configura el Webhook."
echo "   URL: (La que apareció arriba en el despliegue de webhook-meta)"
echo "   Token: segumex_secure_token"
echo "---------------------------------------------------"
