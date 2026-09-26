// Version history for the documents in a folder, kept in a private git repository
// at <folder>/.prosedesk/history. It never touches the user's own .git: it uses an
// explicit --git-dir, ignores itself via .prosedesk/.gitignore, runs no hooks, and
// commits file contents straight into the index (the working tree is never read).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

let gitAvailable = null
function hasGit() {
  if (gitAvailable === null) {
    try { execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true }); gitAvailable = true }
    catch { gitAvailable = false }
  }
  return gitAvailable
}

export function createHistory(folder) {
  const dir = path.join(folder, '.prosedesk')
  const gitDir = path.join(dir, 'history')

  const git = (args, input) => execFileSync('git', [
    '--git-dir', gitDir,
    '--work-tree', folder,
    '-c', `core.hooksPath=${path.join(gitDir, 'no-hooks')}`,
    '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false',
    '-c', 'user.name=ProseDesk',
    '-c', 'user.email=prosedesk@localhost',
    ...args,
  ], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024 })

  let ready = false
  function ensure() {
    if (ready) return true
    if (!hasGit()) return false
    try {
      if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
        fs.mkdirSync(dir, { recursive: true })
        git(['init', '-q'])
        fs.writeFileSync(path.join(dir, '.gitignore'), '# Keep ProseDesk history out of your own git repository.\n*\n')
        fs.writeFileSync(path.join(dir, 'README.txt'),
          'ProseDesk version history for the documents in this folder.\n' +
          'Deleting this folder deletes the history; your documents are not affected.\n')
        if (process.platform === 'win32') {
          try { execFileSync('attrib', ['+h', dir], { stdio: 'ignore', windowsHide: true }) } catch {}
        }
      }
      ready = true
    } catch (err) {
      console.error('[history] disabled:', err.message.trim())
    }
    return ready
  }

  return {
    get enabled() { return hasGit() },

    // Records `content` as the new version of `name`. Returns false if nothing changed.
    snapshot(name, content, label) {
      if (!ensure()) return false
      try {
        const sha = git(['hash-object', '-w', '--stdin'], content).trim()
        let head = ''
        try { head = git(['rev-parse', `HEAD:${name}`]).trim() } catch {}
        if (head === sha) return false
        git(['update-index', '--add', '--cacheinfo', `100644,${sha},${name}`])
        git(['commit', '-q', '--no-verify', '-m', label])
        return true
      } catch (err) {
        console.error('[history] snapshot failed:', err.message.trim())
        return false
      }
    },

    list(name, limit = 300) {
      if (!ready && !fs.existsSync(path.join(gitDir, 'HEAD'))) return []
      if (!ensure()) return []
      try {
        return git(['log', '-n', String(limit), '--format=%H%x09%at%x09%s', '--', name])
          .split('\n').filter(Boolean).map(line => {
            const [hash, at, ...rest] = line.split('\t')
            return { hash, time: Number(at) * 1000, label: rest.join('\t') }
          })
      } catch {
        return []   // no commits yet
      }
    },

    read(hash, name) {
      if (!ensure() || !/^[0-9a-f]{7,40}$/i.test(hash)) return null
      try { return git(['show', `${hash}:${name}`]) } catch { return null }
    },
  }
}
