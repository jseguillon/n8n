# Substrate Sandbox Test TODO

Implement the following before treating the Substrate provider as equivalent to
the original Docker/DinD/Sysbox sandbox. Use the Docker tests as the behavior
reference; do not port Docker runtime, network, or Sysbox-specific assertions.

## Authorization E2E

At the authenticated gateway policy boundary, prove a caller cannot select a
different Actor or Atespace, including attempts to control the
`ate-target-actor` header. This belongs in the deployment/gateway test suite,
not this repository. It cannot run until that deployment component exists.
