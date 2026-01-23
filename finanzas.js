window.SegumexFinanzas = {
    /**
     * Calcula la comisión para un pago específico.
     * @param {number} primaNeta - Monto total de la prima neta anual.
     * @param {number} numPagos - Cantidad total de pagos al año (1, 2, 4, 12).
     * @param {number} porcentajeComision - Porcentaje de comisión (ej. 10).
     * @returns {number} Monto de la comisión para ese recibo.
     */
    calcularComision: function (primaNeta, numPagos, porcentajeComision) {
        const pn = parseFloat(primaNeta) || 0;
        const np = parseInt(numPagos) || 1;
        const pct = parseFloat(porcentajeComision) || 0;
        return (pn / np) * (pct / 100);
    },

    /**
     * Calcula el monto de cada recibo para el cliente.
     * @param {number} primaTotal - Monto total a pagar (con impuestos).
     * @param {number} numPagos - Cantidad de pagos.
     * @returns {number} Monto por recibo.
     */
    calcularMontoRecibo: function (primaTotal, numPagos) {
        const pt = parseFloat(primaTotal) || 0;
        const np = parseInt(numPagos) || 1;
        return pt / np;
    },

    /**
     * Genera el calendario de pagos.
     * @param {string} fechaInicioISO - Fecha de inicio YYYY-MM-DD.
     * @param {number} numPagos - Cantidad de pagos (1, 2, 4, 12).
     * @returns {Array} Lista de objetos con fecha estimada.
     */
    generarCalendarioPagos: function (fechaInicioISO, numPagos) {
        const calendario = [];
        const np = parseInt(numPagos) || 1;
        // Usamos SegumexDate si existe, o Date nativo con precaución de zona horaria
        // Asumimos entrada YYYY-MM-DD
        let fechaBase = window.SegumexDate ? window.SegumexDate.parse(fechaInicioISO) : new Date(fechaInicioISO + "T12:00:00");

        if (isNaN(fechaBase.getTime())) fechaBase = new Date(); // Fallback

        for (let i = 0; i < np; i++) {
            const fechaCuota = new Date(fechaBase);
            // Avanzar meses
            fechaCuota.setMonth(fechaBase.getMonth() + (i * (12 / np)));

            calendario.push({
                numero: i + 1,
                totalPagos: np,
                fecha: fechaCuota
            });
        }
        return calendario;
    },

    /**
     * Determina el estado de un recibo.
     * @param {Date} fechaLimite - Objeto Date de la fecha límite.
     * @param {boolean} esPagado - Si ya está marcado como pagado.
     * @returns {string} 'pagado', 'vencido', 'proximo', 'pendiente'.
     */
    calcularEstadoRecibo: function (fechaLimite, esPagado) {
        if (esPagado) return 'pagado';

        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);
        const limite = new Date(fechaLimite);
        limite.setHours(0, 0, 0, 0);

        const diffTime = limite - hoy;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays < 0) return 'vencido';
        if (diffDays <= 30) return 'proximo';
        return 'pendiente';
    },

    diffDias: function (fechaLimite) {
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);
        const limite = new Date(fechaLimite);
        limite.setHours(0, 0, 0, 0);
        const diffTime = limite - hoy;
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    },

    formatoMoneda: function (valor) {
        return new Intl.NumberFormat('es-MX', {
            style: 'currency',
            currency: 'MXN',
            minimumFractionDigits: 2
        }).format(valor);
    }
};
