// Finding a meeting's audio recording. The Wispr MCP has no audio; the desktop app keeps each
// meeting's audio on the machine that recorded it, in `meetings/<meeting id>/upload.ogg` (or a raw
// `mic.pcm`) under its data folder, named by the same id the MCP returns. Pure: the mod spawns
// these argv lists (locally, or over ssh on each browser host) and parses what they print.

/** A Wispr meeting id. Only an id that passes this ever reaches a command. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Args: <id> <file base> <dest>. Finds the recording and prints `path=`, `stat=<bytes> <epoch s>`
// and `dur=<s>` (empty when no probe answers), or `none=<dir searched>`. Then copies it into
// <dest> (empty: the Downloads folder; `-`: no copy) as <base>.<ext>, else <base>-2.<ext> and up,
// never over an existing file, and prints `copy=<path>`.
// macOS path measured 2026-11-24. shortcut: the Windows branch (%APPDATA%, %USERPROFILE%, run by
// Git Bash's sh) is a guess, never measured; measure it on a Windows machine with the app.
const SCRIPT = `id=$1 base=$2 dest=$3
if [ -n "$APPDATA" ]; then m="$APPDATA/Wispr Flow/meetings"; dl="$USERPROFILE/Downloads"
else m="$HOME/Library/Application Support/Wispr Flow/meetings"; dl="$HOME/Downloads"; fi
src=
for f in upload.ogg mic.pcm; do if [ -f "$m/$id/$f" ]; then src="$m/$id/$f"; break; fi; done
if [ -z "$src" ]; then echo "none=$m/$id"; exit 0; fi
echo "path=$src"
echo "stat=$(stat -c "%s %Y" "$src" 2>/dev/null || stat -f "%z %m" "$src")"
echo "dur=$( (ffprobe -v error -show_entries format=duration -of csv=p=0 "$src" || afinfo "$src" | sed -n "s/^estimated duration: \\([0-9.]*\\).*/\\1/p") 2>/dev/null)"
[ "$dest" = - ] && exit 0
[ -n "$dest" ] || dest=$dl
ext=\${src##*.} to="$dest/$base.$ext" n=1
while [ -e "$to" ]; do n=$((n+1)); to="$dest/$base-$n.$ext"; done
cp "$src" "$to" && echo "copy=$to"`

// Args: <dir> <file base> <ext>. Prints the first free <dir>/<base>[-N].<ext> on this machine.
const FREE = `to="$1/$2.$3" n=1
while [ -e "$to" ]; do n=$((n+1)); to="$1/$2-$n.$3"; done
echo "$to"`

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'` // one word for a POSIX shell
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']

/** The argv that finds (and copies, see SCRIPT) meeting `id`'s recording on this machine, or on `host`. */
export function findArgv(id: string, base: string, dest: string, host?: string): string[] {
  if (!UUID.test(id)) throw new Error(`not a Wispr meeting id: "${id}"`)
  if (!host) return ['sh', '-c', SCRIPT, 'sh', id, base, dest]
  return ['ssh', '-n', ...SSH, host, `sh -c ${q(SCRIPT)} sh ${[id, base, dest].map(q).join(' ')}`]
}

/** The argv that prints a free file name in `dir` on this machine. */
export const freeArgv = (dir: string, base: string, ext: string) => ['sh', '-c', FREE, 'sh', dir, base, ext]

/** scp of `path` on `host` to `to`. A space in the remote path becomes `?`: legacy scp hands the
 * path to the remote shell, SFTP mode to its own glob, and `?` matches the space in both. */
export const scpArgv = (host: string, path: string, to: string) => ['scp', ...SSH, `${host}:${path.replace(/ /g, '?')}`, to]

/** `<title>-<YYYY-MM-DD>`, safe as a file name on any of the three systems. */
export function fileBase(title: string, when?: string): string {
  const t = title.replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^[-.]+|-+$/g, '').slice(0, 80) || 'meeting'
  if (!when) return t
  const d = new Date(when) // the local date: a meeting late in the evening is not filed under tomorrow's UTC date
  if (isNaN(d.getTime())) return `${t}-${when.slice(0, 10)}`
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface Found {
  path: string
  size: number // bytes
  mtime: number // ms
  duration?: number // s
  copy?: string
}

/** What SCRIPT printed: the recording, or the folder it looked in. */
export function parseFound(out: string): Found | { none: string } | undefined {
  const v: Record<string, string> = {}
  for (const l of out.split(/\r?\n/)) {
    const i = l.indexOf('=')
    if (i > 0) v[l.slice(0, i)] = l.slice(i + 1)
  }
  if (v.none) return { none: v.none }
  if (!v.path) return undefined
  const [size, mtime] = (v.stat ?? '').split(' ').map(Number)
  return { path: v.path, size, mtime: mtime * 1000, ...(Number(v.dur) > 0 && { duration: Number(v.dur) }), ...(v.copy && { copy: v.copy }) }
}
