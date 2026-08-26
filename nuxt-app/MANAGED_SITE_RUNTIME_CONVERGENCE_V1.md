# Managed Site Runtime Convergence V1

## Public target boundary

All managed-site public origins and URL references use the shared `assertPublicHttpsUrl()` guard. V1 accepts only canonical HTTPS targets on port 443, without credentials or wildcard hostnames, and rejects IANA special-use IPv4/IPv6 ranges, normalized private-IP representations, reserved/documentation domains, and sensitive query material. The guard is deterministic and does not perform network access.

> V1 deliberately does not perform DNS lookup. A syntactically public hostname is not treated as proof that its current DNS answer is public.

## Future network executor requirements

Before any future fetcher, crawler, deployment executor, or provider adapter opens a connection, it must resolve the hostname and validate every returned IPv4 and IPv6 address against the same special-use policy. DNS answers must be checked again after every redirect, and the connection must be rejected if the redirect target, resolved address, scheme, port, or credentials violate the policy. Redirect chains must be bounded and must not bypass the shared guard by following a URL parsed only inside a provider SDK.

This V1 repair does not enable a fetcher, crawler, DNS writer, deployment provider, registrar, or external Shopify/payment operation. Provider-neutral adapters remain fail closed unless an explicitly injected mock is used in tests.
