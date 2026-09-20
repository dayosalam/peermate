import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StoryboardSchema, type WhiteboardAction } from './storyboard.js'
import { whiteboardFrame } from './whiteboard.js'
import { correctKnownGeometry } from './plan.js'

const actions: WhiteboardAction[] = [
  {
    type: 'box',
    x: 0.08,
    y: 0.2,
    width: 0.24,
    height: 0.24,
    label: 'Input',
    color: '#2563eb',
    at: 0.1,
    duration: 0.2,
  },
  {
    type: 'arrow',
    fromX: 0.34,
    fromY: 0.32,
    toX: 0.68,
    toY: 0.32,
    label: 'changes',
    color: '#dc2626',
    at: 0.45,
    duration: 0.2,
  },
]

test('a whiteboard scene changes as its explanation advances', () => {
  const opening = whiteboardFrame(actions, 0, 'A lesson', 'notes.pdf, p.2', [])
  const middle = whiteboardFrame(actions, 0.3, 'A lesson', 'notes.pdf, p.2', [])
  const ending = whiteboardFrame(actions, 1, 'A lesson', 'notes.pdf, p.2', [])
  assert.notDeepEqual(opening, middle)
  assert.notDeepEqual(middle, ending)
})

test('the storyboard rejects coordinates outside the visible board', () => {
  assert.throws(() =>
    StoryboardSchema.parse({
      title: 'Bad plan',
      course: 'TEST',
      scenes: [
        {
          narration: 'This should not render.',
          visual: {
            kind: 'whiteboard',
            actions: [{ ...actions[0], x: 1.2 }],
          },
          source: null,
        },
      ],
    }),
  )
})

test('mechanically known structural arrows point in the right direction', () => {
  const storyboard = StoryboardSchema.parse({
    title: 'Forces',
    course: 'CVE 575',
    scenes: [
      {
        narration: 'A load points down and the reactions point up.',
        visual: {
          kind: 'whiteboard',
          actions: [
            {
              type: 'arrow',
              fromX: 0.5,
              fromY: 0.6,
              toX: 0.5,
              toY: 0.4,
              label: '12 kN',
              at: 0,
              duration: 0.2,
            },
            {
              type: 'arrow',
              fromX: 0.2,
              fromY: 0.4,
              toX: 0.2,
              toY: 0.6,
              label: 'R_A',
              at: 0.2,
              duration: 0.2,
            },
            { type: 'write', text: 'Beam', x: 0.4, y: 0.5, at: 0.4, duration: 0.2 },
            { type: 'line', fromX: 0.1, fromY: 0.5, toX: 0.9, toY: 0.5, at: 0.6, duration: 0.2 },
          ],
        },
        source: 'notes.pdf, p.1',
      },
    ],
  })
  const corrected = correctKnownGeometry(storyboard)
  const [load, reaction] =
    corrected.scenes[0]!.visual.kind === 'whiteboard' ? corrected.scenes[0]!.visual.actions : []
  assert.equal(load?.type, 'arrow')
  assert.equal(reaction?.type, 'arrow')
  if (load?.type === 'arrow' && reaction?.type === 'arrow') {
    assert.ok(load.toY > load.fromY)
    assert.ok(reaction.toY < reaction.fromY)
  }
})
