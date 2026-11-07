/**
 * Operator CLI.
 *
 *   docker compose exec app node dist/cli.js create-user
 *   docker compose exec app node dist/cli.js list-users
 *   docker compose exec app node dist/cli.js reset-password
 *
 * Accounts are created here rather than from passwords in `.env`
 * (HANDOFF section 11), and there is no sign-up route in the app.
 *
 * Passwords are never taken from argv, because argv is visible to anything
 * that can list processes. Either type it at the prompt (it is not echoed) or
 * pipe it in with `--password-stdin`.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createDatabase, type Database } from "./db.js";
import { EnvValidationError, getEnv } from "./env.js";
import { MIN_PASSWORD_LENGTH, WeakPasswordError, hashPassword } from "./auth/password.js";

const USAGE = `Headroom CLI

Usage:
  node dist/cli.js create-user [--name NAME] [--initial X] [--email EMAIL] [--password-stdin]
  node dist/cli.js list-users
  node dist/cli.js reset-password [--email EMAIL] [--password-stdin]
  node dist/cli.js help

Notes:
  The first account created also creates the household.
  Passwords are read from the prompt (not echoed) or from stdin with --password-stdin.
`;

interface Flags {
  readonly command: string;
  readonly name?: string;
  readonly initial?: string;
  readonly email?: string;
  readonly passwordStdin: boolean;
}

function parseArgs(argv: readonly string[]): Flags {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  let passwordStdin = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--password-stdin") {
      passwordStdin = true;
      continue;
    }
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Flag --${key} needs a value.`);
      }
      flags[key] = value;
      i += 1;
    }
  }

  return {
    command,
    name: flags["name"],
    initial: flags["initial"],
    email: flags["email"],
    passwordStdin,
  };
}

/** Read a line, echoing what is typed. */
async function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(question)).trim();
    if (answer === "" && fallback !== undefined) return fallback;
    return answer;
  } finally {
    rl.close();
  }
}

/**
 * Read a line without echoing it, so a password does not stay on the screen
 * or in the terminal's scrollback.
 */
async function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY) {
    throw new Error(
      "No terminal available to type a password into. Use --password-stdin and pipe it in instead.",
    );
  }

  stdout.write(question);

  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  // Swallow the echo that readline would otherwise write for each keypress.
  const originalWrite = (
    rl as unknown as { _writeToOutput?: (text: string) => void }
  )._writeToOutput;
  (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};

  try {
    const answer = await rl.question("");
    stdout.write("\n");
    return answer;
  } finally {
    if (originalWrite) {
      (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = originalWrite;
    }
    rl.close();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function getPassword(flags: Flags, prompt: string): Promise<string> {
  if (flags.passwordStdin) {
    const password = await readStdin();
    if (password === "") throw new Error("No password arrived on stdin.");
    return password;
  }

  const first = await askSecret(prompt);
  const second = await askSecret("Type it again: ");
  if (first !== second) throw new Error("The two passwords did not match. Nothing was changed.");
  return first;
}

/** Palette from the design tokens, so the two initials look right in the UI. */
const COLORS = [
  { fg: "#2A3C8F", bg: "#E3E7F7" },
  { fg: "#7A4A00", bg: "#F3E6CF" },
  { fg: "#0F6B55", bg: "#D7EBE3" },
  { fg: "#3F4844", bg: "#ECEAE3" },
] as const;

async function createUser(db: Database, flags: Flags): Promise<void> {
  const name = flags.name ?? (await ask("Name: "));
  if (name === "") throw new Error("A name is required.");

  const suggestedInitial = name.charAt(0).toUpperCase();
  const initial = (flags.initial ?? (await ask(`Initial [${suggestedInitial}]: `, suggestedInitial)))
    .trim()
    .toUpperCase();
  if (initial === "" || initial.length > 2) throw new Error("The initial must be one or two letters.");

  const email = (flags.email ?? (await ask("Email: "))).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`"${email}" is not an email address.`);

  const existing = await db.prisma.user.findFirst({ where: { email } });
  if (existing) throw new Error(`There is already an account for ${email}.`);

  const password = await getPassword(
    flags,
    `Password (at least ${MIN_PASSWORD_LENGTH} characters, not shown): `,
  );
  const passwordHash = await hashPassword(password);

  // The first account also creates the household it belongs to.
  let household = await db.prisma.household.findFirst({ where: { deletedAt: null } });
  let createdHousehold = false;
  if (!household) {
    household = await db.prisma.household.create({ data: { name: "Our household" } });
    createdHousehold = true;
  }

  const userCount = await db.prisma.user.count({ where: { householdId: household.id } });
  const color = COLORS[userCount % COLORS.length] ?? COLORS[3];

  const user = await db.prisma.user.create({
    data: {
      householdId: household.id,
      name,
      initial,
      email,
      passwordHash,
      colorFg: color.fg,
      colorBg: color.bg,
    },
  });

  if (createdHousehold) {
    stdout.write(`Created the household "${household.name}".\n`);
  }
  stdout.write(`Created ${user.name} (${user.initial}) <${user.email}>.\n`);
}

async function listUsers(db: Database): Promise<void> {
  const users = await db.prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: { name: true, initial: true, email: true, createdAt: true, deletedAt: true },
  });

  if (users.length === 0) {
    stdout.write("No accounts yet. Create one with: node dist/cli.js create-user\n");
    return;
  }

  for (const user of users) {
    const state = user.deletedAt ? " (removed)" : "";
    stdout.write(`${user.initial}  ${user.name.padEnd(12)} ${user.email}${state}\n`);
  }
}

async function resetPassword(db: Database, flags: Flags): Promise<void> {
  const email = (flags.email ?? (await ask("Email of the account to reset: "))).trim().toLowerCase();

  const user = await db.prisma.user.findFirst({ where: { email, deletedAt: null } });
  if (!user) throw new Error(`No account for ${email}.`);

  const password = await getPassword(flags, `New password for ${user.name} (not shown): `);
  const passwordHash = await hashPassword(password);

  await db.prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, version: { increment: 1 }, updatedAt: new Date() },
  });

  // Force a fresh sign-in everywhere, which is the point of a reset.
  const { count } = await db.prisma.session.deleteMany({ where: { userId: user.id } });
  stdout.write(`Password updated for ${user.name}. Signed out ${count} session(s).\n`);
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.command === "help" || flags.command === "--help" || flags.command === "-h") {
    stdout.write(USAGE);
    return;
  }

  let env;
  try {
    env = getEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(`\n${error.message}\n`);
      process.exit(78);
    }
    throw error;
  }

  const db = createDatabase(env);
  try {
    switch (flags.command) {
      case "create-user":
        await createUser(db, flags);
        break;
      case "list-users":
        await listUsers(db);
        break;
      case "reset-password":
        await resetPassword(db, flags);
        break;
      default:
        console.error(`Unknown command "${flags.command}".\n\n${USAGE}`);
        process.exitCode = 64; // EX_USAGE
    }
  } finally {
    await db.close();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof WeakPasswordError) {
    console.error(error.message);
    process.exit(65);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
