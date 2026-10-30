# local-env para Herdr

Mod de [Herdr](https://herdr.dev) que muestra los entornos de [local-env](https://github.com/etendosoftware/etendo-localenv) (Etendo): qué está levantado, en qué puertos, y el progreso de cada `local-env up`, `worktree` o `sync` mientras corre. Es el equivalente en Herdr del mod `local-env-progress` que etendo-localenv trae para omp y Claude Code, y lee los mismos archivos.

Solo lee archivos locales y consulta puertos de tu máquina. No levanta ni frena nada.

## Requisitos

- La app Herdr (`herdr-app`) 0.1.9 o superior.
- `local-env` con algún checkout de Etendo, y un espacio de Herdr abierto en ese checkout o en uno de sus entornos.
- `curl` y `ps` (vienen con macOS).

## Instalación

El mod es la carpeta `mods/local-env/`. Clonás el repo y la enlazás en la carpeta de mods de Herdr; así `git pull` alcanza para actualizar:

```bash
git clone https://github.com/valenvivaldi/herdr-local-env.git
ln -s "$PWD/herdr-local-env/mods/local-env" ~/.config/herdr-app/mods/local-env
herdr-app check ~/.config/herdr-app/mods/local-env
```

### El panel en el sidebar

Los layouts que trae Herdr no se pueden editar, así que primero clonás el tuyo (en el ejemplo, `main`):

```bash
herdr-app do layout.clone '{"name":"main","as":"mi-layout"}'
```

En `~/.config/herdr-app/layouts/mi-layout.json`, dentro de la columna `sidebar-lists`, agregás este bloque entre `spaces` y `agents`:

```json
{
  "id": "local-env",
  "type": "block",
  "content": { "mod": "local-env", "props": { "block": "local-env" } },
  "size": { "px": 77 },
  "min": 41
}
```

`props.block` tiene que ser igual al `id` del bloque: el panel lo usa para ajustar su alto a la cantidad de filas.

### Flotante, en un layout sin sidebar (como win98)

Si tu layout no tiene sidebar, clonalo igual y agregá el panel como bloque flotante en el nodo que lo contiene (en win98, el nodo `screen`). Flotando, el panel tiene un ancho fijo y crece según sus filas. Lo podés arrastrar y Herdr se acuerda de dónde lo dejaste.

```bash
herdr-app do layout.clone '{"name":"win98","as":"win98-local"}'
```

```json
"floating": [
  { "id": "local-env", "content": { "mod": "local-env" }, "edge": "right", "align": "center" }
]
```

### Atajo

Agregá el de `keys.json` de este repo a `~/.config/herdr-app/keys.json`, dentro de `"global"`:

```json
"cmd-shift-e": "mod.open:local-env"
```

Sin atajo, desde cualquier terminal: `herdr-app do mod.open --name local-env`.

## Uso

**Panel "Local env"**, entre Spaces y Agents:

- Una fila por entorno levantado, con un punto verde (amarillo si solo está la base o Tomcat todavía arranca) y sus puertos: Tomcat y SPA. Un click en un puerto abre la app en el navegador.
- Mientras corre un `local-env up`, `worktree` o `sync`, una fila con spinner, el paso (`3/6 build`) y el tiempo. Cuando termina, aparece una notificación y la fila pasa a ser la del entorno levantado. Si falla, la fila queda en rojo 10 minutos; el detalle está en el tooltip y en `build/local-env/local-env.log`.
- Un click en una fila, o en **Todos**, abre el diálogo.
- Con el sidebar plegado quedan solo los puntos.

**Diálogo** (`cmd-shift-e`): todos los entornos, también los parados. De cada uno muestra los servicios (Tomcat, PG, SPA, BFF) con su puerto y URL, los repos en worktree, adoptados o copiados, la última ejecución, y cómo levantarlo si está parado.

| Tecla | Qué hace |
|---|---|
| `r` | Volver a consultar ahora. |
| `Esc` | Cerrar. |

## Cómo encuentra los entornos

- Toma la carpeta de cada espacio de Herdr y la de la terminal enfocada, y sube hasta el checkout de Etendo, como hace local-env (`build.xml` + `gradle.properties` + `src-db`). Desde un entorno llega al checkout principal por `build/local-env/source-root`.
- Los entornos son el checkout principal y cada carpeta de `<checkout>/../.worktrees/` que tenga `build/local-env/env`. Si usás `LOCALENV_WORKTREES` en otra ruta, alcanza con tener abierto un espacio dentro de alguno de esos entornos.
- Tomcat está **levantado** cuando `/<context>/security/Login` responde 200, y **arrancando** cuando responde otra cosa. PG y SPA, cuando vive el pid de `pgdata/postmaster.pid` o de `plugins/etendo-go/spa.pid`. El BFF va con el SPA.
- El progreso sale de `build/local-env/progress.json` de cada entorno y de `.worktrees/.progress/*.json`. Es el formato v1 de etendo-localenv (`docs/design.md` §7.1).

Los archivos se leen cada 5 s (cada 1 s mientras algo corre) y los puertos se consultan cada 15 s.

## Limitaciones

- Solo ve espacios de esta máquina, no los de otras máquinas de Herdr.
- Un entorno fuera de `.worktrees/` y sin ningún espacio abierto adentro no aparece.

## Desarrollo

La lógica está en `lib.js` (sin dependencias) y `probe.js` (recibe el acceso a disco y a procesos), así se prueba con node sin Herdr:

```bash
npm test
```
