// SVG occupancy-timeline (Gantt) renderer for the residency page.
// Ported from lil_salem control_panel/apps.mjs renderGantt: a fixed 3-month
// window starting at `windowStartStr` (YYYY-MM-01, defaults to the month of
// today), navigable via the page's ?gw=YYYY-MM query.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * @param rooms rooms with `.occupancy` arrays (db shape)
 * @param todayStr venue-local YYYY-MM-DD
 * @param windowStartStr YYYY-MM-DD (first of a month) or null
 * @param opts { esc, mapLocationLabel } — html escaper + room→location label fn
 */
export function renderGantt(rooms, todayStr, windowStartStr, { esc, mapLocationLabel }) {
  const todayMs = new Date(todayStr + 'T00:00:00Z').getTime();
  const msPerDay = 86400000;

  // 3-month fixed window starting at windowStartStr (YYYY-MM-01).
  // Defensive: a caller-supplied window that isn't a REAL date (out-of-range
  // month like 2026-13, 0000-00, …) must never reach `d.toISOString()` below —
  // that throws RangeError and 500s the whole page. The caller validates too
  // (index.mjs ?gw), this is the belt to that suspenders.
  const defaultStart = todayStr.slice(0, 7) + '-01';
  let winStart = new Date((windowStartStr || defaultStart) + 'T00:00:00Z');
  if (isNaN(winStart.getTime())) {
    winStart = new Date(defaultStart + 'T00:00:00Z');
  }
  winStart.setUTCDate(1);
  const winEnd = new Date(winStart);
  winEnd.setUTCMonth(winEnd.getUTCMonth() + 3);
  const minDate = winStart.getTime();
  const maxDate = winEnd.getTime();

  // Prev / next / today window strings
  const prev = new Date(winStart);
  prev.setUTCMonth(prev.getUTCMonth() - 3);
  const next = new Date(winStart);
  next.setUTCMonth(next.getUTCMonth() + 3);
  const fmtYM = (d) => d.toISOString().slice(0, 7);
  const prevWin = fmtYM(prev);
  const nextWin = fmtYM(next);
  const todayWin = todayStr.slice(0, 7);
  const curWinLabel = (() => {
    const a = winStart;
    const b = new Date(winEnd);
    b.setUTCDate(b.getUTCDate() - 1);
    return `${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()} – ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  })();

  // Layout constants
  const labelW = 110;
  const chartW = 700;
  const rowH = 28;
  const padTop = 30;
  // Show ALL rooms, not just those with occupancies
  const allRooms = rooms;
  const svgH = padTop + allRooms.length * rowH + 10;
  const totalW = labelW + chartW + 20;

  function dayToX(dateStr) {
    const ms = new Date(dateStr + 'T00:00:00Z').getTime();
    return labelW + ((ms - minDate) / (maxDate - minDate)) * chartW;
  }

  // Month labels (one per month in the 3-month window)
  let monthLabels = '';
  const cursor = new Date(minDate);
  while (cursor.getTime() < maxDate) {
    const x = labelW + ((cursor.getTime() - minDate) / (maxDate - minDate)) * chartW;
    monthLabels += `<text x="${x + 4}" y="16" fill="#666" font-size="10">${MONTHS[cursor.getUTCMonth()]} ${cursor.getUTCFullYear()}</text>`;
    monthLabels += `<line x1="${x}" y1="20" x2="${x}" y2="${svgH}" stroke="#1a1a1a" stroke-width="1"/>`;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  // Today marker
  const todayX = labelW + ((todayMs - minDate) / (maxDate - minDate)) * chartW;
  let todayMarker = '';
  if (todayX >= labelW && todayX <= labelW + chartW) {
    todayMarker = `<line x1="${todayX}" y1="${padTop - 5}" x2="${todayX}" y2="${svgH}" stroke="#d9534f" stroke-width="1.5" stroke-dasharray="4,3"/>`;
    todayMarker += `<text x="${todayX}" y="${padTop - 8}" fill="#d9534f" font-size="9" text-anchor="middle">today</text>`;
  }

  // Room rows — drawn in layers so adjacent bars never paint over a prior
  // bar's label: (1) labels + backgrounds + rects, (2) bar text clipped per-bar.
  let rowsSvg = '';
  let labelsSvg = '';
  let clipsSvg = '';
  const barColors = ['#2a5a3a', '#1a4a6a', '#4a3a5a', '#5a4a1a', '#1a5a5a', '#5a2a3a'];
  const guestColor = '#3a3a1a';
  let colorIdx = 0;

  allRooms.forEach((room, i) => {
    const y = padTop + i * rowH;

    // Room label — hovering shows the physical location on the building floor map.
    const rNameRaw = room.room_name || 'Room ' + room.room_number;
    const rName = esc(rNameRaw);
    const loc = mapLocationLabel(room);
    const labelTip = loc ? `<title>${esc(rNameRaw + ' — ' + loc)}</title>` : '';
    const labelText = loc ? '📍 ' + rName : rName;
    rowsSvg += `<text x="${labelW - 8}" y="${y + rowH / 2 + 4}" fill="#999" font-size="11" text-anchor="end" style="${loc ? 'cursor:help' : ''}">${labelText}${labelTip}</text>`;

    // Row background
    rowsSvg += `<rect x="${labelW}" y="${y + 2}" width="${chartW}" height="${rowH - 4}" rx="2" fill="#0d0d0d"/>`;

    // Occupancy bars
    for (const o of room.occupancy || []) {
      const startX = dayToX(o.start_date);
      const endDateStr =
        o.end_date || new Date(todayMs + 90 * msPerDay).toISOString().split('T')[0];
      const endX = dayToX(endDateStr);
      // Clamp
      const x1 = Math.max(startX, labelW);
      const x2 = Math.min(endX, labelW + chartW);
      if (x2 <= x1) continue;

      const color = o.is_guest ? guestColor : barColors[colorIdx % barColors.length];
      const barY = y + 4;
      const barH = rowH - 8;
      const barW = x2 - x1;
      const name = esc(o.is_guest ? o.guest_name : o.user_name);
      const tooltipEnd = o.end_date || 'ongoing';
      const tooltipText = `${o.is_guest ? o.guest_name : o.user_name}: ${o.start_date} - ${tooltipEnd}`;

      // Clickable bar that opens the edit modal (page JS binds .gantt-bar).
      rowsSvg += `<rect class="gantt-bar" data-occ-id="${esc(o.id)}" data-occ-name="${esc(o.is_guest ? o.guest_name : o.user_name)}" data-occ-guest="${o.is_guest ? 1 : 0}" data-occ-start="${esc(o.start_date)}" data-occ-end="${esc(o.end_date || '')}" data-occ-notes="${esc(o.notes || '')}" x="${x1}" y="${barY}" width="${barW}" height="${barH}" rx="3" fill="${color}" stroke="${o.is_guest ? '#666' : '#5cb85c'}" stroke-width="0.5" style="cursor:pointer"><title>${esc(tooltipText)}</title></rect>`;

      // Name label, clipped to the bar so it never spills into adjacent bars.
      if (barW > 16) {
        const clipId = esc(`gantt-clip-${o.id}`);
        clipsSvg += `<clipPath id="${clipId}"><rect x="${x1}" y="${barY}" width="${barW}" height="${barH}"/></clipPath>`;
        labelsSvg += `<text x="${x1 + 4}" y="${barY + barH - 4}" fill="#ddd" font-size="10" clip-path="url(#${clipId})" style="pointer-events:none">${name}${!o.end_date ? ' (ongoing)' : ''}</text>`;
      }

      if (!o.is_guest) colorIdx++;
    }
  });

  return `
    <div style="margin-bottom:24px;overflow-x:auto;background:#111;border:1px solid #222;border-radius:8px;padding:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px;flex-wrap:wrap">
        <h3 style="font-size:14px;color:#999;margin:0;font-weight:500">Occupancy Timeline</h3>
        <div style="display:flex;align-items:center;gap:6px">
          <a class="btn btn-sm" href="?gw=${prevWin}">‹ Prev</a>
          <a class="btn btn-sm" href="?gw=${todayWin}">Today</a>
          <a class="btn btn-sm" href="?gw=${nextWin}">Next ›</a>
          <span style="font-size:12px;color:#888;margin-left:6px">${curWinLabel}</span>
        </div>
      </div>
      <svg width="${totalW}" height="${svgH}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
        <defs>${clipsSvg}</defs>
        ${monthLabels}
        ${todayMarker}
        ${rowsSvg}
        ${labelsSvg}
      </svg>
      <div style="display:flex;gap:16px;margin-top:8px;font-size:11px;color:#666">
        <div style="display:flex;align-items:center;gap:4px"><div style="width:12px;height:8px;border-radius:2px;background:#2a5a3a;border:0.5px solid #5cb85c"></div>Resident</div>
        <div style="display:flex;align-items:center;gap:4px"><div style="width:12px;height:8px;border-radius:2px;background:#3a3a1a;border:0.5px solid #666"></div>Guest</div>
        <div style="display:flex;align-items:center;gap:4px"><div style="width:2px;height:10px;background:#d9534f"></div>Today</div>
      </div>
    </div>`;
}
