// Tests never write a cache into a repository: in-process main() calls and spawned CLIs (which inherit this
// environment) run without it. Cache tests delete the variable around the code under test.
process.env.SCOPE_CACHE = "off";
