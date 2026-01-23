window.SegumexPDF = {
    /**
     * Genera ficha técnica de cliente
     */
    generarFichaCliente: function (cliente, polizas) {
        if (!window.jspdf) { alert("Librería PDF no cargada"); return; }
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();

        // --- ENCABEZADO ---
        doc.setFillColor(19, 91, 236); // Primary Blue
        doc.rect(0, 0, 210, 40, 'F');

        doc.setTextColor(255, 255, 255);
        doc.setFontSize(22);
        doc.setFont("helvetica", "bold");
        doc.text("SEGUMEX", 15, 20); // Logotipo Texto de momento
        doc.setFontSize(12);
        doc.setFont("helvetica", "normal");
        doc.text("Ficha Técnica de Cliente", 15, 30);

        // --- DATOS CLIENTE ---
        doc.setTextColor(50, 50, 50);
        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.text("Datos Generales", 15, 55);

        const infoCliente = [
            [`Nombre`, `${cliente.nombre} ${cliente.apellido || ''}`],
            [`RFC`, `${cliente.rfc || '---'}`],
            [`Teléfono`, `${cliente.telefono || '---'}`],
            [`Email`, `${cliente.email || '---'}`],
            [`Dirección`, `${cliente.direccion || ''}, ${cliente.municipio || ''}`],
            [`Estatus`, `${cliente.estatus || 'Activo'}`]
        ];

        doc.autoTable({
            startY: 60,
            head: [],
            body: infoCliente,
            theme: 'plain',
            styles: { fontSize: 10, cellPadding: 1.5 },
            columnStyles: { 0: { fontStyle: 'bold', cellWidth: 40 } }
        });

        // --- DETALLE POLIZAS ---
        let finalY = doc.lastAutoTable.finalY + 15;

        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.text("Pólizas Activas", 15, finalY);

        const filasPolizas = (polizas || []).map(p => [
            p.no_poliza || '---',
            p.aseguradora,
            (p.ramo || '').toUpperCase(),
            p.vence,
            window.SegumexFinanzas.formatoMoneda(p.prima || 0)
        ]);

        doc.autoTable({
            startY: finalY + 5,
            head: [['Póliza', 'Aseguradora', 'Ramo', 'Vencimiento', 'Prima Total']],
            body: filasPolizas,
            headStyles: { fillColor: [19, 91, 236], textColor: 255, fontStyle: 'bold' },
            bodyStyles: { fontSize: 10 },
            alternateRowStyles: { fillColor: [240, 240, 240] }
        });

        // --- FOOTER ---
        const pageCount = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            doc.setFontSize(8);
            doc.setTextColor(150);
            doc.text('Generado automáticamente por Segumex CRM', 15, 285);
            doc.text(`Página ${i} de ${pageCount}`, 190, 285, { align: 'right' });
        }

        doc.save(`Ficha_${cliente.nombre}_${new Date().toISOString().slice(0, 10)}.pdf`);
    },

    /**
     * Genera recibo de pago para envío
     */
    generarRecibo: function (datosRecibo, status) {
        if (!window.jspdf) { alert("Librería PDF no cargada"); return; }
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ format: 'a5' }); // Media carta para recibos es mejor

        // --- MARCO ---
        doc.setLineWidth(1);
        doc.setDrawColor(200);
        doc.rect(5, 5, 138, 200);

        // --- HEADER ---
        doc.setFillColor(19, 91, 236);
        doc.rect(6, 6, 136, 30, 'F');
        doc.setTextColor(255);
        doc.setFontSize(18);
        doc.setFont("helvetica", "bold");
        doc.text("SEGUMEX", 15, 20);
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(status === 'vencido' ? "AVISO DE COBRANZA" : "RECORDATORIO DE PAGO", 15, 30);

        // --- INFO ---
        doc.setTextColor(0);
        doc.setFontSize(12);
        doc.text(`Estimado(a): ${datosRecibo.cliente}`, 15, 50);

        doc.setFontSize(10);
        doc.text(`Por medio de la presente le notificamos el detalle de su pago:`, 15, 60);

        const dataRows = [
            ['Concepto', datosRecibo.concepto],
            ['Póliza', datosRecibo.poliza],
            ['Aseguradora', datosRecibo.aseguradora],
            ['Fecha Límite', window.SegumexDate.toDisplay(datosRecibo.fecha)],
            ['Monto a Pagar', window.SegumexFinanzas.formatoMoneda(datosRecibo.monto)]
        ];

        doc.autoTable({
            startY: 70,
            body: dataRows,
            theme: 'grid',
            headStyles: { fillColor: [50, 50, 50] },
            columnStyles: { 0: { fontStyle: 'bold', cellWidth: 40 } },
            margin: { left: 15, right: 15 }
        });

        const finalY = doc.lastAutoTable.finalY + 10;

        if (status === 'vencido') {
            doc.setTextColor(220, 50, 50);
            doc.setFontSize(12);
            doc.setFont("helvetica", "bold");
            doc.text("ESTE RECIBO SE ENCUENTRA VENCIDO", 74, finalY + 10, { align: 'center' });
            doc.setFontSize(10);
            doc.setFont("helvetica", "normal");
            doc.setTextColor(0);
            doc.text("Le rogamos regularizar su situación a la brevedad.", 74, finalY + 20, { align: 'center' });
        } else {
            doc.setTextColor(0);
            doc.text("Agradecemos su preferencia.", 74, finalY + 10, { align: 'center' });
        }

        // --- FOOTER ---
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text('Segumex - Asesoría Profesional en Seguros', 74, 190, { align: 'center' });

        doc.save(`Recibo_${datosRecibo.poliza}_${datosRecibo.idPago}.pdf`);
    }
};
