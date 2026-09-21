import assert from 'node:assert/strict'
import test from 'node:test'
import { paceScriptedScene, validateScriptedScene } from './scripted.js'

test('paces actions across narration with no gap over half a second', () => {
  const scene = paceScriptedScene(
    {
      source: 'notes.pdf, p.3',
      actions: [
        { type: 'title', text: 'Road design', x: 0.05, y: 0.05, at: 0, duration: 0.1 },
        {
          type: 'bullets',
          items: ['alignment', 'drainage', 'traffic'],
          x: 0.1,
          y: 0.25,
          at: 0.1,
          duration: 0.1,
        },
        { type: 'road', x: 0.6, y: 0.3, width: 0.3, height: 0.4, at: 0.2, duration: 0.1 },
      ],
    },
    20,
  )
  assert.deepEqual(validateScriptedScene(scene, 20), [])
  assert.ok(scene.actions.at(-1)!.at + scene.actions.at(-1)!.duration >= 0.97)
})

test('rejects off-board and inactive scenes', () => {
  const errors = validateScriptedScene(
    {
      source: null,
      actions: [
        { type: 'title', text: 'Late', x: 0.8, y: 0.1, at: 0.2, duration: 0.1 },
        { type: 'box', x: 0.9, y: 0.2, width: 0.3, height: 0.2, at: 0.8, duration: 0.1 },
      ],
    },
    10,
  )
  assert.ok(errors.some((issue) => issue.includes('inactivity')))
  assert.ok(errors.some((issue) => issue.includes('right edge')))
})
