
https://oryxen.tech/barcode/
# Barcode → Excel (React)

Un escáner de códigos de barras con cámara (móvil/PC) que agrega automáticamente cada lectura como una nueva fila y permite exportar a Excel (.xlsx).

## Funciones principales
- **Escaneo continuo con cámara** (ZXing)
- **Auto-guardar**: cada lectura válida agrega una nueva fila ("salta de línea" automáticamente)
- **Anti-duplicado** configurable (ms)
- **Deep Scan**: reintentos automáticos (hasta 4) si no detecta nada:
  1) resolución normal
  2) resolución alta
  3) cambio de cámara
  4) reinicio profundo del lector
- **Fallbacks**:
  - Entrada manual
  - Leer desde foto (upload)
- **Exportar a Excel** (SheetJS) — descarga un archivo .xlsx listo
- **Persistencia local** (localStorage) para no perder lecturas al recargar

## Requisitos
- Node.js 18+ (recomendado) — funciona con Node 20/22

## Ejecutar en local
```bash
npm install
npm run dev
```
Luego abre la URL que muestra la consola.

> Nota: Para usar cámara en móvil, abre la app en **HTTPS** (o `localhost`).

## Build
```bash
npm run build
npm run preview
```

## Exportar Excel
Botón **Exportar Excel** genera `barcode-scans-YYYY-MM-DDTHH-mm-ss.xlsx`.

## Estructura
- `src/App.jsx` UI + scanner + export
- `src/app.css` estilos

