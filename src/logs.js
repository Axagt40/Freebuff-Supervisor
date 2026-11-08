'use strict'

const fs = require('fs')
const { paths, ensureDirs } = require('./paths')

function readTail (file, count) {
  let data
  try {
    data = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const lines = data.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-count)
}

function showLogs (argv = []) {
  const follow = argv.includes('-f') || argv.includes('--follow')
  let count = 40
  const flagIndex = argv.findIndex((arg) => arg === '-n' || arg === '--lines')
  if (flagIndex >= 0) {
    const parsed = Number(argv[flagIndex + 1])
    if (Number.isFinite(parsed) && parsed > 0) count = Math.floor(parsed)
  }

  ensureDirs()
  const file = paths().supervisorLog
  const tail = readTail(file, count)
  if (tail === null) {
    console.log('no supervisor log yet — run `sfreebuff` first')
  } else if (tail.length > 0) {
    console.log(tail.join('\n'))
  }

  if (!follow) return

  let offset = 0
  try {
    offset = fs.statSync(file).size
  } catch {
    offset = 0
  }

  const timer = setInterval(() => {
    try {
      const stats = fs.statSync(file)
      if (stats.size < offset) offset = 0
      if (stats.size === offset) return
      const fd = fs.openSync(file, 'r')
      try {
        const length = stats.size - offset
        const buffer = Buffer.alloc(length)
        fs.readSync(fd, buffer, 0, length, offset)
        offset = stats.size
        process.stdout.write(buffer)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      // The log may be mid-rotation; try again next tick.
    }
  }, 250)

  process.on('SIGINT', () => {
    clearInterval(timer)
    process.exit(0)
  })
}

module.exports = { showLogs }
