// Configuración global de Supabase para Segumex CRM
const SUPABASE_URL = "https://mmhdpbygdvdyujiktvqa.supabase.co";
const SUPABASE_KEY = "sb_publishable_O1bvUB9wmNIV7_qLbmAnYw_9G18eMS5";

// Exponer claves para usos especiales (como crear usuarios sin cerrar sesión)
window.supabaseUrl = SUPABASE_URL;
window.supabaseKey = SUPABASE_KEY;

// Inicializar el cliente
const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Exportar para uso global
window.supabaseClient = _supabase;

// --- UTILERÍA GLOBAL DE FECHAS (ISO 8601) ---
const SegumexDate = {
    // Parsea cualquier fecha (ISO YYYY-MM-DD o Local DD/MM/YYYY) a objeto Date (Midnight Local)
    parse: function (dateStr) {
        if (!dateStr) return null;
        if (dateStr instanceof Date) return dateStr;

        // Si viene como DD/MM/YYYY
        if (typeof dateStr === 'string' && dateStr.includes('/')) {
            const [d, m, y] = dateStr.split('/');
            return new Date(y, m - 1, d, 0, 0, 0); // Mes es base 0
        }

        // Si viene como YYYY-MM-DD (Estándar HTML/SQL)
        if (typeof dateStr === 'string' && dateStr.includes('-')) {
            const [y, m, d] = dateStr.split('-');
            return new Date(y, m - 1, d, 0, 0, 0);
        }

        return new Date(dateStr); // Fallback
    },

    // Convierte para display UI (DD/MM/YYYY)
    toDisplay: function (dateStr) {
        const d = this.parse(dateStr);
        if (!d || isNaN(d)) return "---";
        return d.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });
    },

    // Convierte para Display corto (22 Ene)
    toShortDisplay: function (dateStr) {
        const d = this.parse(dateStr);
        if (!d || isNaN(d)) return "---";
        return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
    },

    // Convierte para Input HTML o Supabase (YYYY-MM-DD)
    toISO: function (dateObjOrStr) {
        const d = this.parse(dateObjOrStr);
        if (!d || isNaN(d)) return "";
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    },

    // Días de diferencia entre dos fechas (f1 - f2)
    diffDays: function (dateTarget, dateBase = new Date()) {
        const t = this.parse(dateTarget);
        const b = this.parse(dateBase);
        // Normalizar a media noche para evitar errores por horas
        t.setHours(0, 0, 0, 0);
        b.setHours(0, 0, 0, 0);
        return Math.ceil((t - b) / (1000 * 60 * 60 * 24));
    }
};

window.SegumexDate = SegumexDate;