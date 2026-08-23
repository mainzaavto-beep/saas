import { C } from "@/lib/palette.js";

export const dynamic = 'force-dynamic';
export default function Page() {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: C.muted, fontFamily: 'system-ui' }}>
      <h2 style={{ color: C.ink }}>Контент</h2>
      <p>Управление контентом товаров (описания, фото, A/B тесты).</p>
      <p style={{ fontSize: 13, color: C.faint }}>Требует переноса контент-агента и его БД. Будет доступно позже.</p>
    </div>
  );
}
