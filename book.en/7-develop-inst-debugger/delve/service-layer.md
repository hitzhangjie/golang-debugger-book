# Service Layer

The service layer make embedding Delve into other programs much easier. We can integrate Delve with GoLand, VSCode, Atom, Vim, etc.

Well, the service layer offers services for supporting debug. I will use debug service to represent the service layer.

- client can issue debug operations by RPC request to debug service
- when debug service started, supported debug operations will be registered
- client send specific debug operation to debug service, debug service will route the request to corresponding function to process

