// ═══════════════════════════════════════════════════════════════
    // ESTADO GLOBAL
    // ═══════════════════════════════════════════════════════════════
    let archivos = [];          // File objects
    let cotizaciones = [];      // Extracted data from each PDF
    let hdiDescuento = false;
    let hdiPrecioOriginal = null;
    let hdiPrecioDescuento = null;
    let currentStep = 1;
    let leadId = null;
    let folioCotizacion = null;
    let pdfBlob = null;
    let pdfStoragePath = null;

    // ─── Cache de logos (base64 obtenidos del edge function) ───
    const logoCache = new Map(); // aseguradora → base64 data URL

    async function cargarLogosAseguradoras() {
        const nombres = [...new Set(cotizaciones.map(c => c.aseguradora).filter(Boolean))];
        await Promise.all(nombres.map(async (nombre) => {
            if (logoCache.has(nombre)) return;
            try {
                const { data } = await window.supabaseClient.functions.invoke('get-insurer-logo', {
                    body: { aseguradora: nombre }
                });
                if (data?.logo) {
                    logoCache.set(nombre, data.logo);
                    console.log(`✅ Logo cargado: ${nombre}`);
                }
            } catch (e) {
                console.warn(`Sin logo para ${nombre}:`, e);
            }
        }));
    }

    // ─── Colores por aseguradora ───
    const INSURER_COLORS = {
        'hdi': 'color-hdi', 'qualitas': 'color-qualitas', 'gnp': 'color-gnp',
        'axa': 'color-axa', 'mapfre': 'color-mapfre', 'chubb': 'color-chubb',
        'afirme': 'color-afirme', 'zurich': 'color-zurich', 'inbursa': 'color-inbursa',
        'banorte': 'color-banorte', 'atlas': 'color-atlas', 'primero': 'color-primero',
        'ana': 'color-ana'
    };

    const INSURER_DOMAINS = {
        'hdi': 'hdi-seguros.com.mx',
        'qualitas': 'qualitas.com.mx',
        'gnp': 'gnp.com.mx',
        'axa': 'axa.com.mx',
        'mapfre': 'mapfre.com.mx',
        'chubb': 'chubb.com',
        'afirme': 'afirme.com.mx',
        'zurich': 'zurich.com.mx',
        'inbursa': 'inbursa.com',
        'banorte': 'banorte.com',
        'atlas': 'atlas.com.mx',
        'primero': 'primero-seguros.com',
        'ana': 'ana.com.mx'
    };

    function getInsurerColor(nombre) {
        const n = (nombre || '').toLowerCase();
        for (const [key, cls] of Object.entries(INSURER_COLORS)) {
            if (n.includes(key)) return cls;
        }
        return 'color-default';
    }

    function getInsurerDomain(nombre) {
        const n = (nombre || '').toLowerCase();
        for (const [key, domain] of Object.entries(INSURER_DOMAINS)) {
            if (n.includes(key)) return domain;
        }
        return null;
    }

    function getInsurerInitials(nombre) {
        if (!nombre) return '?';
        const words = nombre.trim().toUpperCase().split(/\s+/);
        if (words.length === 1) return words[0].substring(0, 4);
        return words.map(w => w[0]).join('').substring(0, 4);
    }

    // ═══════════════════════════════════════════════════════════════
    // INIT
    // ═══════════════════════════════════════════════════════════════
    function init() {
        irPaso(1);

        // File input listener
        const fileInput = document.getElementById('fileInput');
        fileInput.addEventListener('change', function(e) {
            const files = e.target.files;
            if (files && files.length > 0) {
                handleFiles(files);
            }
            // reset value so same file can be selected again
            setTimeout(() => { fileInput.value = ''; }, 100);
        });

        // Drag and drop en el dropZone
        const dropZone = document.getElementById('dropZone');
        dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
        dropZone.addEventListener('drop', e => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
        });

        // Pre-fill CP from vCP to lCP
        document.getElementById('vCP').addEventListener('input', e => {
            document.getElementById('lCP').value = e.target.value;
        });

        // (validación ocurre al hacer clic en el botón)
    }

    // ═══════════════════════════════════════════════════════════════
    // STEPPER
    // ═══════════════════════════════════════════════════════════════
    function irPaso(n) {
        currentStep = n;
        [1,2,3,4].forEach(i => {
            document.getElementById(`step${i}`).classList.toggle('hidden', i !== n);
            const dot = document.getElementById(`dot${i}`);
            if (i < n) { dot.className = 'step-dot done'; dot.innerHTML = '<span class="material-symbols-outlined text-sm">check</span>'; }
            else if (i === n) { dot.className = 'step-dot active'; dot.textContent = i; }
            else { dot.className = 'step-dot inactive'; dot.textContent = i; }
        });
        [1,2,3].forEach(i => {
            const line = document.getElementById(`line${i}`);
            if (line) line.className = 'step-line' + (i < n ? ' done' : '');
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // MANEJO DE ARCHIVOS
    // ═══════════════════════════════════════════════════════════════
    function handleDrop(event) {
        event.preventDefault();
        document.getElementById('dropZone').classList.remove('dragover');
        handleFiles(event.dataTransfer.files);
    }

    function handleFiles(files) {
        for (const file of files) {
            if (archivos.length >= 4) { showToast('Máximo 4 cotizaciones', 'warning'); break; }
            const esPDF = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
            if (!esPDF) { showToast(`${file.name} no es PDF`, 'error'); continue; }
            if (file.size > 10 * 1024 * 1024) { showToast(`${file.name} excede 10MB`, 'error'); continue; }
            if (archivos.find(f => f.name === file.name)) continue;
            archivos.push(file);
        }
        renderFileList();
    }

    function renderFileList() {
        const list = document.getElementById('fileList');
        if (archivos.length === 0) { list.classList.add('hidden'); return; }
        list.classList.remove('hidden');
        list.innerHTML = archivos.map((f, i) => `
            <div class="cot-card flex items-center gap-3 p-3">
                <span class="material-symbols-outlined text-red-400">picture_as_pdf</span>
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium truncate">${f.name}</p>
                    <p class="text-xs text-[#9da6b9]">${(f.size/1024).toFixed(1)} KB</p>
                </div>
                <button onclick="removerArchivo(${i})" class="text-[#9da6b9] hover:text-red-400">
                    <span class="material-symbols-outlined text-sm">close</span>
                </button>
            </div>
        `).join('');
    }

    // Los listeners se agregan en init() para garantizar que el DOM esté listo

    function removerArchivo(i) {
        archivos.splice(i, 1);
        renderFileList();
    }

    // ═══════════════════════════════════════════════════════════════
    // PASO 1 → 2: Procesar PDFs con IA
    // ═══════════════════════════════════════════════════════════════
    async function procesarCotizaciones() {
        if (archivos.length === 0) { alert('Selecciona al menos 1 PDF de cotización.'); return; }
        if (!document.getElementById('vCreadoPor').value) { alert('Selecciona quién crea la cotización: Albert o Soto.'); return; }

        const btn = document.getElementById('btnProcesar');
        btn.disabled = true;
        btn.innerHTML = '<span class="material-symbols-outlined text-base spin">refresh</span> Analizando con IA...';

        cotizaciones = [];

        try {
            for (let i = 0; i < archivos.length; i++) {
                const file = archivos[i];
                btn.innerHTML = `<span class="material-symbols-outlined text-base spin">refresh</span> Analizando ${i+1}/${archivos.length}...`;

                const base64 = await fileToBase64(file);
                const { data } = await window.supabaseClient.functions.invoke('extract-quote', {
                    body: { pdf_base64: base64, mime_type: 'application/pdf' }
                });

                if (data?.success && data?.data) {
                    // Rellenar campos de vehículo si están vacíos
                    const v = data.data.vehiculo;
                    if (v) {
                        if (!document.getElementById('vMarca').value && v.marca) document.getElementById('vMarca').value = v.marca;
                        if (!document.getElementById('vModelo').value && v.modelo) document.getElementById('vModelo').value = v.modelo;
                        if (!document.getElementById('vAnio').value && v.anio) document.getElementById('vAnio').value = v.anio;
                        if (!document.getElementById('vVersion').value && v.version) document.getElementById('vVersion').value = v.version;
                    }
                    if (!document.getElementById('vCP').value && data.data.cp) {
                        document.getElementById('vCP').value = data.data.cp;
                        document.getElementById('lCP').value = data.data.cp;
                    }
                    // Detectar periodicidad automáticamente
                    if (data.data.forma_pago) {
                        const mapaForma = { 1: 'anual', 2: 'semestral', 4: 'trimestral', 12: 'mensual' };
                        const formaDetectada = mapaForma[data.data.forma_pago];
                        if (formaDetectada) document.getElementById('vFormaPago').value = formaDetectada;
                    }
                    cotizaciones.push({ ...data.data, _archivo: file.name });
                } else {
                    cotizaciones.push({ aseguradora: file.name.replace('.pdf',''), _archivo: file.name, _error: true });
                }
            }

            renderCotizacionesGrid();

            // Cargar logos de aseguradoras en segundo plano (no bloquea la UI)
            cargarLogosAseguradoras().catch(() => {});

            irPaso(2);

        } catch(e) {
            showToast('Error al analizar: ' + e.message, 'error');
        }

        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-outlined text-base">auto_awesome</span> Analizar con IA y continuar';
    }

    function fileToBase64(file) {
        return new Promise((res, rej) => {
            const reader = new FileReader();
            reader.onload = e => res(e.target.result.split(',')[1]);
            reader.onerror = rej;
            reader.readAsDataURL(file);
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // PASO 2: Render de cotizaciones extraídas (editable)
    // ═══════════════════════════════════════════════════════════════
    function renderCotizacionesGrid() {
        const grid = document.getElementById('cotizacionesGrid');
        grid.innerHTML = cotizaciones.map((cot, idx) => {
            const color = getInsurerColor(cot.aseguradora);
            const initials = getInsurerInitials(cot.aseguradora);
            const coberturas = (cot.coberturas || []).slice(0, 8);
            const precio = cot.prima_total ? `$${Number(cot.prima_total).toLocaleString('es-MX', {minimumFractionDigits:2})}` : '—';

            return `
            <div class="cot-card p-4">
                <div class="flex items-center gap-3 mb-3">
                    <div class="insurer-badge ${color} text-white">${initials}</div>
                    <div class="flex-1">
                        <input value="${cot.aseguradora || ''}" onchange="cotizaciones[${idx}].aseguradora=this.value; this.parentElement.previousElementSibling.textContent=getInsurerInitials(this.value);"
                            class="bg-transparent border-b border-[#3b4354] focus:border-primary outline-none text-sm font-bold w-full text-white" />
                        ${cot._error ? '<span class="text-xs text-yellow-400">⚠ Datos incompletos</span>' : ''}
                    </div>
                    <button onclick="removerCotizacion(${idx})" class="text-[#9da6b9] hover:text-red-400">
                        <span class="material-symbols-outlined text-sm">delete</span>
                    </button>
                </div>
                <div class="space-y-1 mb-3 text-xs">
                    ${coberturas.map(c => `
                        <div class="flex justify-between text-[#9da6b9] border-b border-[#282e39] pb-1">
                            <span class="truncate mr-2">${c.nombre || ''}</span>
                            <span class="text-white shrink-0">${c.suma_asegurada || '—'}</span>
                        </div>
                    `).join('')}
                </div>
                <div class="flex items-center justify-between pt-2 border-t border-[#282e39]">
                    <span class="text-xs text-[#9da6b9]">Prima total</span>
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-[#9da6b9]">$</span>
                        <input type="number" value="${cot.prima_total || ''}"
                            onchange="cotizaciones[${idx}].prima_total=parseFloat(this.value)"
                            class="bg-[#282e39] border border-[#3b4354] rounded px-2 py-1 text-sm text-white w-24 focus:outline-none focus:border-primary" />
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    function removerCotizacion(i) {
        cotizaciones.splice(i, 1);
        if (cotizaciones.length === 0) { irPaso(1); return; }
        renderCotizacionesGrid();
    }

    // ═══════════════════════════════════════════════════════════════
    // MODAL HDI DESCUENTO
    // ═══════════════════════════════════════════════════════════════
    function abrirModalHDI() {
        const tieneHDI = cotizaciones.some(c => (c.aseguradora||'').toLowerCase().includes('hdi'));
        document.getElementById('hdiExisteMsg').classList.toggle('hidden', tieneHDI);
        document.getElementById('modalHDI').classList.remove('hidden');
    }

    function setHDIDescuento(val) {
        hdiDescuento = val;
        document.getElementById('hdiDescuentoFields').classList.toggle('hidden', !val);
        document.getElementById('btnHDINo').classList.toggle('border-primary', !val);
        document.getElementById('btnHDISi').classList.toggle('border-green-500', val);
    }

    function confirmarHDIYGenerar() {
        if (hdiDescuento) {
            hdiPrecioOriginal = parseFloat(document.getElementById('hdiPrecioOriginal').value) || null;
            hdiPrecioDescuento = parseFloat(document.getElementById('hdiPrecioDescuento').value) || null;
            if (!hdiPrecioDescuento) { showToast('Ingresa el precio con descuento', 'error'); return; }
        }
        document.getElementById('modalHDI').classList.add('hidden');
        irPaso(3);
        // Pre-fill CP
        document.getElementById('lCP').value = document.getElementById('vCP').value;
    }

    // ═══════════════════════════════════════════════════════════════
    // PASO 3: Lead
    // ═══════════════════════════════════════════════════════════════
    async function buscarClienteExistente() {
        const tel = document.getElementById('buscarTel').value.trim();
        if (tel.length !== 10) { showToast('Ingresa 10 dígitos', 'error'); return; }

        const { data } = await window.supabaseClient.from('leads').select('id, nombre, telefono, email, estado').eq('telefono', tel).maybeSingle();
        const res = document.getElementById('resultadoBusqueda');
        res.classList.remove('hidden');

        if (data) {
            res.innerHTML = `<div class="bg-[#282e39] rounded-lg p-3 text-sm">
                <p class="text-green-400 font-medium mb-1">✓ Cliente encontrado</p>
                <p class="text-white">${data.nombre}</p>
                <p class="text-[#9da6b9] text-xs">${data.email || 'Sin email'}</p>
                <button onclick="usarLeadExistente(${data.id}, '${data.nombre}', '${data.telefono||tel}', '${data.email||''}')"
                    class="mt-2 text-xs text-primary hover:underline">Usar este lead</button>
            </div>`;
            // Pre-fill
            document.getElementById('lNombre').value = data.nombre || '';
            document.getElementById('lTelefono').value = data.telefono || tel;
            document.getElementById('lEmail').value = data.email || '';
        } else {
            res.innerHTML = `<p class="text-xs text-[#9da6b9]">No se encontró el cliente. Se creará uno nuevo.</p>`;
            document.getElementById('lTelefono').value = tel;
        }
    }

    function usarLeadExistente(id, nombre, tel, email) {
        leadId = id;
        document.getElementById('lNombre').value = nombre;
        document.getElementById('lTelefono').value = tel;
        document.getElementById('lEmail').value = email;
        showToast('Lead existente seleccionado', 'success');
    }

    async function guardarLeadYContinuar() {
        const nombre = document.getElementById('lNombre').value.trim();
        const apellido = document.getElementById('lApellido').value.trim();
        const telefono = document.getElementById('lTelefono').value.trim();

        if (!nombre || !telefono) { showToast('Nombre y teléfono son requeridos', 'error'); return; }

        const btn = document.getElementById('btnGuardarLead');
        btn.disabled = true;
        btn.innerHTML = '<span class="material-symbols-outlined text-base spin">refresh</span> Guardando...';

        try {
            const vMarca = document.getElementById('vMarca').value.trim();
            const vModelo = document.getElementById('vModelo').value.trim();
            const vAnio = document.getElementById('vAnio').value.trim();
            const vVersion = document.getElementById('vVersion').value.trim();
            const cp = document.getElementById('vCP').value.trim();
            const formaPago = document.getElementById('vFormaPago').value;
            const creadoPor = document.getElementById('vCreadoPor').value;

            if (!leadId) {
                // Crear nuevo lead (tabla usa 'nombre' como campo único)
                const nombreCompleto = apellido ? `${nombre} ${apellido}` : nombre;
                const { data: nuevoLead, error } = await window.supabaseClient.from('leads').insert({
                    nombre: nombreCompleto,
                    telefono,
                    email: document.getElementById('lEmail').value.trim() || null,
                    codigo_postal: cp || document.getElementById('lCP').value.trim() || null,
                    producto: 'Seguro de Auto',
                    etapa: document.getElementById('lEstado').value,
                    fecha: new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }),
                    prob: 'media',
                    valor: 0,
                    auto_modelo: `${vMarca} ${vModelo} ${vAnio}`.trim() || null,
                    auto_anio: vAnio || null,
                    auto_version: vVersion || null,
                }).select().single();

                if (error) throw error;
                leadId = nuevoLead.id;
            }

            // Guardar multicotización en DB
            const { data: mc, error: mcErr } = await window.supabaseClient.from('multicotizaciones').insert({
                lead_id: leadId,
                creado_por: creadoPor,
                vehiculo_marca: vMarca,
                vehiculo_modelo: vModelo,
                vehiculo_anio: vAnio,
                vehiculo_version: vVersion,
                cp,
                forma_pago: formaPago,
                cotizaciones: cotizaciones,
                hdi_descuento: hdiDescuento,
                hdi_precio_sin_descuento: hdiPrecioOriginal,
                hdi_precio_descuento: hdiPrecioDescuento
            }).select().single();

            if (mcErr) throw mcErr;
            folioCotizacion = mc.folio;

            // Pre-fill WhatsApp modal
            document.getElementById('waTelefono').value = telefono;
            document.getElementById('waNombre').value = nombre;

            generarDocumento();
            irPaso(4);
            document.getElementById('subtitleStep4').textContent = `Folio #${folioCotizacion} · Lead: ${nombre} ${apellido}`;
            actualizarPreviewWA();

        } catch(e) {
            showToast('Error: ' + e.message, 'error');
        }

        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-outlined text-base">save</span> Guardar lead y ver documento';
    }

    // ═══════════════════════════════════════════════════════════════
    // PASO 4: Generar documento HTML
    // ═══════════════════════════════════════════════════════════════
    function generarDocumento() {
        const vMarca = document.getElementById('vMarca').value.trim();
        const vModelo = document.getElementById('vModelo').value.trim();
        const vAnio = document.getElementById('vAnio').value.trim();
        const vVersion = document.getElementById('vVersion').value.trim();
        const cp = document.getElementById('vCP').value.trim();
        const formaPago = document.getElementById('vFormaPago').value;
        const creadoPor = document.getElementById('vCreadoPor').value;
        const hoy = new Date().toLocaleDateString('es-MX', { day:'2-digit', month:'long', year:'numeric' });
        const vencimiento = new Date(Date.now() + 30*24*60*60*1000).toLocaleDateString('es-MX', { day:'2-digit', month:'long', year:'numeric' });

        const formaPagoLabel = { anual:'Anual', semestral:'Semestral', trimestral:'Trimestral', mensual:'Mensual' }[formaPago] || formaPago;

        // Columnas
        const cols = cotizaciones.map(cot => {
            const color = getInsurerColor(cot.aseguradora);
            const initials = getInsurerInitials(cot.aseguradora);
            const esHDI = (cot.aseguradora||'').toLowerCase().includes('hdi');
            const coberturas = (cot.coberturas || []).filter(c => c.incluida !== false); // sin límite

            // Insurer logo: usa base64 del cache (obtenido server-side), fallback a badge de color
            const logoData = logoCache.get(cot.aseguradora);
            const logoHTML = logoData
                ? `<div style="height:60px;display:flex;align-items:center;justify-content:center;margin:0 auto 8px;">
                      <img class="insurer-logo" src="${logoData}" alt="${cot.aseguradora}"
                           style="max-height:60px;max-width:110px;width:auto;height:auto;object-fit:contain;" />
                   </div>`
                : `<div style="width:56px;height:56px;border-radius:12px;margin:0 auto 8px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;letter-spacing:0.5px;color:white;" class="${color}">${initials}</div>`;

            let precioHTML = '';
            if (esHDI && hdiDescuento && hdiPrecioDescuento) {
                const pctDesc = hdiPrecioOriginal ? Math.round((1 - hdiPrecioDescuento / hdiPrecioOriginal) * 100) : null;
                precioHTML = `
                    <div style="margin-bottom:4px;">
                        ${hdiPrecioOriginal ? `<p style="text-decoration:line-through;color:#999;font-size:12px;margin:0;">$${Number(hdiPrecioOriginal).toLocaleString('es-MX',{minimumFractionDigits:2})}</p>` : ''}
                        <div class="hdi-discount-badge" style="display:inline-block;margin:4px 0;">
                            🔥 PRECIO ESPECIAL<br/>
                            $${Number(hdiPrecioDescuento).toLocaleString('es-MX',{minimumFractionDigits:2})}
                            ${pctDesc ? `<span style="font-size:10px;background:rgba(255,255,255,0.3);padding:1px 5px;border-radius:4px;margin-left:4px;">${pctDesc}% OFF</span>` : ''}
                        </div>
                    </div>`;
            } else if (cot.prima_total) {
                precioHTML = `<p style="font-size:22px;font-weight:900;color:#0f1b3d;margin:4px 0;">$${Number(cot.prima_total).toLocaleString('es-MX',{minimumFractionDigits:2})}</p>`;
            } else {
                precioHTML = `<p style="font-size:16px;color:#666;margin:4px 0;">Consultar</p>`;
            }

            const coberturasHTML = coberturas.length > 0
                ? coberturas.map(c => `
                    <div class="coverage-row">
                        <div style="display:flex;justify-content:space-between;align-items:start;gap:4px;">
                            <span style="color:#374151;flex:1;">${c.nombre || ''}</span>
                            <span style="font-weight:600;color:#111827;text-align:right;font-size:11px;">${c.suma_asegurada || '—'}</span>
                        </div>
                        ${c.deducible && c.deducible !== 'No aplica' ? `<div style="font-size:10px;color:#9ca3af;">Ded: ${c.deducible}</div>` : ''}
                    </div>`).join('')
                : '<div class="coverage-row" style="color:#9ca3af;text-align:center;">Sin detalle disponible</div>';

            return `
            <div class="insurer-col" style="min-width:0;">
                <div class="insurer-col-header" style="background:white;border-bottom:3px solid #e5e7eb;">
                    ${logoHTML}
                    <p style="font-weight:800;font-size:13px;color:#0f1b3d;margin:0 0 2px;">${cot.aseguradora || '—'}</p>
                    ${esHDI && hdiDescuento ? '<span style="font-size:10px;background:#ff6b00;color:white;padding:2px 8px;border-radius:4px;font-weight:700;">DESCUENTO ESPECIAL</span>' : ''}
                </div>
                <div style="background:#f9fafb;padding:6px 12px;border-bottom:1px solid #e5e7eb;">
                    <p style="font-size:9.5px;text-transform:uppercase;letter-spacing:0.8px;color:#6b7280;margin:0;font-weight:600;">Coberturas incluidas</p>
                </div>
                <div class="insurer-col-coverages">${coberturasHTML}</div>
                <div class="price-section">
                    <p style="font-size:10px;color:#6b7280;margin:0 0 4px;text-transform:uppercase;letter-spacing:0.8px;">Prima ${formaPagoLabel}</p>
                    ${precioHTML}
                </div>
            </div>`;
        }).join('');

        const vehiculoStr = [vMarca, vModelo, vAnio, vVersion].filter(Boolean).join(' ') || '—';

        const docHTML = `
        <div class="doc-header">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div style="display:flex;align-items:center;gap:16px;">
                    <img src="segumex%20sin%20fondo.png" alt="Segumex"
                         style="height:70px;width:auto;object-fit:contain;filter:brightness(0) invert(1);"
                         onerror="this.style.display='none';this.nextElementSibling.style.display='block';" />
                    <div style="display:none;">
                        <p style="font-weight:900;font-size:20px;margin:0;letter-spacing:-0.3px;">SEGUMEX</p>
                        <p style="font-size:11px;color:rgba(255,255,255,0.7);margin:0;">Soluciones en Seguros</p>
                    </div>
                </div>
                <div style="text-align:right;">
                    <p style="font-size:11px;color:rgba(255,255,255,0.6);margin:0 0 2px;text-transform:uppercase;letter-spacing:1px;">Multicotización</p>
                    <p style="font-size:24px;font-weight:900;margin:0;letter-spacing:-0.5px;">#${folioCotizacion || '—'}</p>
                    <p style="font-size:10px;color:rgba(255,255,255,0.6);margin:2px 0 0;">Válida hasta ${vencimiento}</p>
                </div>
            </div>
            <div class="doc-info-row" style="margin-top:14px;display:flex;gap:28px;flex-wrap:wrap;padding-top:12px;border-top:1px solid rgba(255,255,255,0.12);">
                <div>
                    <p style="font-size:9.5px;color:rgba(255,255,255,0.5);margin:0 0 2px;text-transform:uppercase;letter-spacing:0.8px;">Vehículo</p>
                    <p style="font-weight:700;font-size:14px;margin:0;">${vehiculoStr}</p>
                </div>
                ${cp ? `<div>
                    <p style="font-size:9.5px;color:rgba(255,255,255,0.5);margin:0 0 2px;text-transform:uppercase;letter-spacing:0.8px;">C.P.</p>
                    <p style="font-weight:700;font-size:14px;margin:0;">${cp}</p>
                </div>` : ''}
                <div>
                    <p style="font-size:9.5px;color:rgba(255,255,255,0.5);margin:0 0 2px;text-transform:uppercase;letter-spacing:0.8px;">Periodicidad</p>
                    <p style="font-weight:700;font-size:14px;margin:0;">${formaPagoLabel}</p>
                </div>
                <div>
                    <p style="font-size:9.5px;color:rgba(255,255,255,0.5);margin:0 0 2px;text-transform:uppercase;letter-spacing:0.8px;">Fecha</p>
                    <p style="font-weight:700;font-size:14px;margin:0;">${hoy}</p>
                </div>
                <div>
                    <p style="font-size:9.5px;color:rgba(255,255,255,0.5);margin:0 0 2px;text-transform:uppercase;letter-spacing:0.8px;">Asesor</p>
                    <p style="font-weight:700;font-size:14px;margin:0;">${creadoPor}</p>
                </div>
            </div>
        </div>
        <div class="doc-body">
            <div style="display:flex;gap:10px;align-items:stretch;">${cols}</div>
        </div>
        <div class="doc-footer">
            <p style="font-size:10px;color:#9ca3af;margin:0;max-width:70%;">Las primas son referenciales y están sujetas a confirmación por la aseguradora. Derechos, recargos e IVA pueden aplicar. Cotización válida 30 días.</p>
            <div style="text-align:right;flex-shrink:0;">
                <p style="font-size:11px;font-weight:700;color:#0f1b3d;margin:0;">SEGUMEX</p>
                <p style="font-size:10px;color:#9ca3af;margin:0;">Asesor: ${creadoPor}</p>
            </div>
        </div>`;

        document.getElementById('printDoc').innerHTML = docHTML;
    }

    function imprimirDocumento() {
        window.print();
    }

    // ═══════════════════════════════════════════════════════════════
    // WHATSAPP
    // ═══════════════════════════════════════════════════════════════
    function abrirModalWhatsApp() {
        actualizarPreviewWA();
        document.getElementById('modalWA').classList.remove('hidden');
    }

    function actualizarPreviewWA() {
        const nombre = document.getElementById('waNombre')?.value || document.getElementById('lNombre')?.value || 'Cliente';
        const creadoPor = document.getElementById('vCreadoPor').value || 'nuestro asesor';
        const msg = `Hola ${nombre} 👋, te escribimos de *Segumex*.\n\nDe acuerdo a la cotización que solicitaste con *${creadoPor}*, te compartimos tu multicotización de seguro de auto.\n\nSi tienes alguna duda, con gusto podemos revisarla contigo.\n\n_Folio: #${folioCotizacion || '—'}_`;
        const preview = document.getElementById('waMsgPreview');
        if (preview) preview.textContent = msg;
    }

    document.addEventListener('input', e => {
        if (['waNombre','waTelefono'].includes(e.target?.id)) actualizarPreviewWA();
    });

    async function enviarWhatsApp() {
        const telefono = document.getElementById('waTelefono').value.trim();
        const nombre = document.getElementById('waNombre').value.trim() || 'Cliente';
        const creadoPor = document.getElementById('vCreadoPor').value || 'nuestro asesor';

        if (telefono.length !== 10) { showToast('Ingresa un teléfono válido de 10 dígitos', 'error'); return; }

        const btn = document.getElementById('btnEnviarWA');
        btn.disabled = true;
        btn.innerHTML = '<span class="material-symbols-outlined text-sm spin">refresh</span> Generando PDF...';

        try {
            // 1. Generar PDF con html2canvas + jsPDF
            const { jsPDF } = window.jspdf;
            const docEl = document.getElementById('printDoc');

            // Temporarily fix width to A4 landscape proportions for consistent capture
            const origWidth = docEl.style.width;
            docEl.style.width = '1050px';
            await new Promise(r => setTimeout(r, 100)); // allow reflow

            const canvas = await html2canvas(docEl, { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false });
            docEl.style.width = origWidth;

            const imgData = canvas.toDataURL('image/jpeg', 0.92);
            const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
            const pW = pdf.internal.pageSize.getWidth();
            const pH = pdf.internal.pageSize.getHeight();
            // Fit image maintaining aspect ratio, centered
            const imgAR = canvas.width / canvas.height;
            const pageAR = pW / pH;
            let drawW = pW, drawH = pH, drawX = 0, drawY = 0;
            if (imgAR > pageAR) { drawH = pW / imgAR; drawY = (pH - drawH) / 2; }
            else { drawW = pH * imgAR; drawX = (pW - drawW) / 2; }
            pdf.addImage(imgData, 'JPEG', drawX, drawY, drawW, drawH);
            const pdfBytes = pdf.output('arraybuffer');

            btn.innerHTML = '<span class="material-symbols-outlined text-sm spin">refresh</span> Subiendo...';

            // 2. Subir a Supabase Storage
            const fileName = `multicotizaciones/folio_${folioCotizacion}_${Date.now()}.pdf`;
            const { error: upErr } = await window.supabaseClient.storage
                .from('documentos-polizas')
                .upload(fileName, pdfBytes, { contentType: 'application/pdf', upsert: true });

            if (upErr) throw upErr;

            // 3. Obtener URL firmada (24h)
            const { data: urlData } = await window.supabaseClient.storage
                .from('documentos-polizas')
                .createSignedUrl(fileName, 86400);

            if (!urlData?.signedUrl) throw new Error('No se pudo generar URL del PDF');

            // Guardar path en DB
            await window.supabaseClient.from('multicotizaciones')
                .update({ pdf_path: fileName, pdf_url: urlData.signedUrl })
                .eq('folio', folioCotizacion);

            btn.innerHTML = '<span class="material-symbols-outlined text-sm spin">refresh</span> Enviando WA...';

            // 4. Mensaje de texto primero
            const mensaje = `Hola ${nombre} 👋, te escribimos de *Segumex*.\n\nDe acuerdo a la cotización que solicitaste con *${creadoPor}*, te compartimos tu multicotización de seguro de auto.\n\nSi tienes alguna duda, con gusto podemos revisarla contigo.\n\n_Folio: #${folioCotizacion}_`;

            const { data: waData, error: waErr } = await window.supabaseClient.functions.invoke('send-test-message', {
                body: {
                    telefono,
                    mensaje,
                    pdf_url: urlData.signedUrl,
                    pdf_nombre: `Multicotizacion_Segumex_${folioCotizacion}.pdf`
                }
            });

            if (waErr) throw waErr;

            document.getElementById('modalWA').classList.add('hidden');
            showToast(`✓ Multicotización enviada a ${telefono}`, 'success');

        } catch(e) {
            showToast('Error al enviar: ' + e.message, 'error');
        }

        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-outlined text-sm">send</span> Enviar';
    }

    // ═══════════════════════════════════════════════════════════════
    // TOAST
    // ═══════════════════════════════════════════════════════════════
    function showToast(msg, type = 'info') {
        const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
        const colors = { success: 'text-green-400', error: 'text-red-400', warning: 'text-yellow-400', info: 'text-blue-400' };
        const toast = document.getElementById('toast');
        const toastMsg = document.getElementById('toastMsg');
        toastMsg.innerHTML = `<span class="${colors[type]}">${icons[type]}</span> ${msg}`;
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 3500);
    }