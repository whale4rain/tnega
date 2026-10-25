# @tnega/ptc-runtime

PTC execution Service Definition (`ctx.ptcRuntime`). A request contains JavaScript,
host tool bindings and cancellation; the result contains a value, text output and
an optional error. The service knows neither Sessions nor the tool registry.

Composition mounts one Provider, then the `tool-ptc` Consumer. Provider and Consumer
only depend on this definition; disposing the Provider closes its active VMs.
