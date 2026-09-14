/**
 * Gives existing records the group they belong to.
 *
 * Retrieval used to be scoped by course code alone, so nothing needed to know which
 * group a row came from. Now the group is the boundary, and a record without one is
 * unreachable — which is the safe direction, but it means every account and every
 * filed document created before this change has to be told where it belongs.
 *
 * Run once, after deploying, with: npm run backfill-tenancy
 *
 * Nothing is deleted and nothing is guessed. A record whose group cannot be worked
 * out is reported and left alone, so an operator resolves it rather than the script
 * silently picking a side.
 */
import { closeMongo, connectMongo, getDb } from '../db/mongo.js'
import { logger } from '../core/logger.js'
import type { Group, Message, Resource, User } from '../models/index.js'

interface Report {
  usersScoped: number
  usersStranded: string[]
  ambiguous: string[]
  resourcesScoped: number
  resourcesStranded: number
}

/**
 * Which groups a student belongs to, inferred from what they registered for.
 *
 * Two approved groups carrying the same course is the one case this cannot settle:
 * that is precisely the cross-institution collision the boundary exists to stop, and
 * picking either one would be a guess about which university they attend.
 */
function groupsFor(user: User, groups: Group[], ambiguous: Set<string>): string[] {
  const mine = new Set<string>()

  for (const key of user.courseKeys) {
    const carrying = groups.filter((group) => group.defaultCourseKey === key)
    if (carrying.length > 1) {
      ambiguous.add(key)
      continue
    }
    const only = carrying[0]
    if (only) mine.add(only.chatJid)
  }

  // A departmental group carries no course, so no course can point at it. Before
  // this change its notices went to every registered student, so every registered
  // student is exactly who was already receiving them.
  for (const group of groups.filter((group) => !group.defaultCourseKey)) {
    mine.add(group.chatJid)
  }

  return [...mine]
}

async function run(): Promise<Report> {
  const db = getDb()
  const report: Report = {
    usersScoped: 0,
    usersStranded: [],
    ambiguous: [],
    resourcesScoped: 0,
    resourcesStranded: 0,
  }

  const groups = (await db
    .collection<Group>('groups')
    .find({ status: 'approved' } as never)
    .toArray()) as Group[]

  const ambiguous = new Set<string>()
  const users = (await db.collection<User>('users').find({}).toArray()) as User[]

  for (const user of users) {
    if (user.groupJids?.length) continue

    const mine = groupsFor(user, groups, ambiguous)
    if (mine.length === 0) {
      report.usersStranded.push(user.phone)
      continue
    }

    await db
      .collection<User>('users')
      .updateOne({ phone: user.phone } as never, { $set: { groupJids: mine } as never })
    report.usersScoped += 1
  }
  report.ambiguous = [...ambiguous]

  // A resource has always carried the message it came from, and that message has
  // always carried its group — so this one is recovered rather than inferred.
  const resources = (await db
    .collection<Resource>('resources')
    .find({ $or: [{ chatJid: null }, { chatJid: { $exists: false } }] } as never)
    .toArray()) as Resource[]

  for (const resource of resources) {
    const source = (await db
      .collection<Message>('messages')
      .findOne({ waMessageId: resource.sourceMessageId } as never)) as Message | null

    if (!source?.chatJid) {
      report.resourcesStranded += 1
      continue
    }

    await db
      .collection<Resource>('resources')
      .updateOne({ sourceMessageId: resource.sourceMessageId } as never, {
        $set: { chatJid: source.chatJid } as never,
      })
    report.resourcesScoped += 1
  }

  return report
}

async function main(): Promise<void> {
  await connectMongo()
  const report = await run()
  await closeMongo()

  console.log(`\nusers given a group:       ${report.usersScoped}`)
  console.log(`resources given a group:   ${report.resourcesScoped}`)

  if (report.ambiguous.length > 0) {
    console.log(
      `\n⚠️  ${report.ambiguous.length} course code(s) are carried by more than one approved group:`,
    )
    console.log(`   ${report.ambiguous.join(', ')}`)
    console.log('   Students taking these were left alone — assign their groups by hand.')
  }

  if (report.usersStranded.length > 0) {
    console.log(`\n⚠️  ${report.usersStranded.length} student(s) matched no group at all:`)
    console.log(`   ${report.usersStranded.join(', ')}`)
    console.log('   They will hear nothing until they are subscribed to one.')
  }

  if (report.resourcesStranded > 0) {
    console.log(
      `\n⚠️  ${report.resourcesStranded} file(s) have no readable source message and stay quarantined.`,
    )
  }

  console.log('')
}

main().catch((error) => {
  logger.error({ err: error }, 'backfill failed')
  process.exit(1)
})
