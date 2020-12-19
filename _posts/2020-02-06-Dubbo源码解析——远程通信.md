---
layout: post
title: Dubbo源码解析——远程通信
date: "2020-02-6 22:00:00 +0800"
categories: Dubbo
tags: java Dubbo rpc
published: true
---

## 前言

在[《Dubbo源码解析——RPC实现原理》](/2020/02/01/Dubbo源码解析-RPC实现原理)一文中我们已经介绍了Dubbo RPC的基本实现原理，Dubbo在实现RPC的时候实现了一套自己的二进制协议 **dubbo** 协议。**dubbo协议** 在处理网络通信的时候引入了`dubbo-remoting`模块。可以认为`dubbo-remoting`模块是为了实现 **dubbo协议** 而引入的模块，所以通过分析`dubbo-remoting`模块，我们可以对如何实现一个RPC的通信层有一个基本的了解。本文，笔者就将带大家一起看看Dubbo是如何封装网络通信的。

*注意：读本文前读者最好对Netty或者其他异步框架实现有基本的了解和使用经验，如果之前对Netty不了解，笔者也为这些读者提供了一节内容简要介绍Netty的基本概念*

## 架构

Dubbo在构建网络通信层的时候，并没有自己造轮子从最基本的Socket通信开始搭建，而是利用了成熟的网络通信框架，比如高性能网络通信框架Netty、Mina以及Grizzly。Dubbo在这些框架之上再进行统一抽象，屏蔽底层具体框架使用的细节，向上提供统一的接口。这样做的好处是后续更换通信框架对上层无感知，便于扩展和升级，同时也降低与框架之间的绑定和耦合。

Dubbo在封装通信框架的时候，将通信层拆分成两层：最下面一层直接和通信框架打交道，屏蔽通信框架的技术细节，封装成点对点的通信模式，通过 **Transporter** 层进行抽象。不同于 **Transporter** 层中数据的传输都是单向的，在 **Transporter** 层之上封装了的 **Exchanger** 数据交换层支持 **Request-Response** 语义，在数据交换层中的通信面向消息，实现消息的编码和解码过程。

![arch](/assets/images/rpc_2-0.png){:width="50%" hight="50%"}

Dubbo在设计 **Transporter** 和 **Exchanger** 层的时候借鉴了很多Netty中关于异步通信的设计，比如`Channel`、`ChannelHandler`，分别用于抽象网络连接和进行异步回调。Dubbo借鉴`ChannelFuture`自己实现了一个`DefaultFuture`。下面，我们先简单介绍下Netty中的一些概念，便于大家理解为什么Dubbo要这么设计Transporter层。

## Netty简介

Netty[^1]是一个基于NIO实现的高性能的网络通信框架。Netty是一个异步通信框架，它的异步通信能力能力得益于NIO的非阻塞IO特性和事件驱动（event-driven）架构。在Netty的设计中包含了几个核心的组件：

* Channels
* Callbacks
* Futures
* ChannelHandler

其中 **Channel** 在Netty中表示一个网络连接的实体，可以想象 **Channel** 是一个管道，用于承载网络上的同通信数据。可以进行读写或者打开关闭操作，是对`Socket`的一种抽象。

**Callback** 表示回调，表示在特定的时间点需要被执行的特定动作，Netty用 **Callback** 来处理事件驱动派发的事件，具体在回调用执行什么逻辑则通过 **ChannelHandler** 进行定义。

**Future** 表示一个未来的计算结果，Netty自己实现了一个`ChannelFuture`用于实现异步请求。由于NIO是一个非阻塞IO，本质上还是一个同步IO，只是不阻塞而已，所以Netty需要利用多线程来实现异步的语义。通过`ChannelFuture`，可以很好的将非阻塞IO的就绪通知和IO过程分派到框架的IO线程中，不阻塞业务线程，在应用层实现异步IO的效果。业务线程可以通过`ChannelFuture`异步获取到IO操作的结果。

Netty将网络请求作为事件进行处理，所以处理事件的逻辑通过 **ChannelHandler** 进行封装以后被 **Callback** 回调处理，回调的过程被IO线程池中的IO线程处理，所以处理请求的过程也是异步的。结合`ChannelFuture`和事件处理，我们可以发现 **Callback** 和 **ChannelFuture** 之间其实是互补的关系，一起实现了Netty的异步能力。而这些，我们都可以从Dubbo的通信层实现中看到它们的影子。

下面，我们从Transporter层开始，逐步介绍Dubbo的remoting层实现。

## Transporter层

Dubbo的通信层采用了CS架构，在Transporter层中抽象了`Server`和`Client`作为通信的两个基础模块，由`Transporter`负责创建。由于设计的时候参考了Netty的异步通信设计，所以在Transporter层中处理网络请求的时候也采用了事件驱动的方式，抽象了`ChannelHandler`来作为异步事件的处理器；类似于Netty的`Channel`概念，Dubbo在Transporter层也抽象了`Channel`用于表示网络连接。

### Channel

Dubbo定义的`Channel`我们可以类别成一个`Socket`，表示一个网络连接。Dubbo通过`Channel`来进行网络通信，它的定义如下：

{% highlight java %}
public interface Channel extends Endpoint {
    InetSocketAddress getRemoteAddress();
    boolean isConnected();
    boolean hasAttribute(String key);
    Object getAttribute(String key);
    void setAttribute(String key, Object value);
    void removeAttribute(String key);
}

public interface Endpoint {
    URL getUrl();
    ChannelHandler getChannelHandler();
    InetSocketAddress getLocalAddress();
    void send(Object message) throws RemotingException; // 1
    void send(Object message, boolean sent) throws RemotingException; // 1
    void close();
    void close(int timeout);
    void startClose();
    boolean isClosed();
}
{% endhighlight %}

1. `Channel`的`send()`方法继承自`Endpoint`，用于向网络中发送数据。

### ChannelHandler
Dubbo通过自定义的`ChannelHandler`处理网络通信中发生的事件，比如对于服务端来说，一个来自客户端的请求将会被`ChannelHandler`捕获并触发处理逻辑；而对于客户端来说，请求结果的返回也是通过`ChannelHandler`被处理。

{% highlight java %}
public interface ChannelHandler {
    void connected(Channel channel) throws RemotingException;
    void disconnected(Channel channel) throws RemotingException;
    void sent(Channel channel, Object message) throws RemotingException;
    void received(Channel channel, Object message) throws RemotingException;
    void caught(Channel channel, Throwable exception) throws RemotingException;
}
{% endhighlight %}

我们可以看到`ChannelHandler`接口中定义的都是一些回调接口，用于处理网络框架捕获到的事件。

Dubbo通过适配的方式将`ChannelHandler`接入异步网络通信框架的事件处理流程，比如对于Netty来说，Dubbo通过`NettyHandler`将`ChannelHandler`适配成Netty自己的`ChannelHandler`，实现通信框架的集成。针对不同的通信框架，各自实现了自己的适配器，比如：`MinaHandler`、`GrizzlyHandler`等。

### Transporter

在Transporter层中`Transporter`用于创建网络中的客户端和服务端，Dubbo基于不同的网络框架实现了多种`Transporter`实现。比如`NettyTransporter`就是基于Netty的`Transporter`实现。下面是`Transporter`的接口定义：

{% highlight java %}
@SPI("netty")
public interface Transporter {
    @Adaptive({Constants.SERVER_KEY, Constants.TRANSPORTER_KEY})
    Server bind(URL url, ChannelHandler handler) throws RemotingException;

    @Adaptive({Constants.CLIENT_KEY, Constants.TRANSPORTER_KEY})
    Client connect(URL url, ChannelHandler handler) throws RemotingException;
}
{% endhighlight %}

`Transporter`通过`bind()`创建服务端，服务端由`Server`实现；`connect()`用于创建客户端`Client`。参数`ChannelHandler`用于处理`Server`或者`Client`中发生的事件，最终会被转换成底层网络框架自己的时间处理器，比如在`NettyServer`中，`ChannelHandler`会被转换成Netty自己的事件处理器。

{% highlight java %}
public class NettyTransporter implements Transporter {
    public static final String NAME = "netty3";
    
    @Override
    public Server bind(URL url, ChannelHandler listener) throws RemotingException {
        return new NettyServer(url, listener);
    }

    @Override
    public Client connect(URL url, ChannelHandler listener) throws RemotingException {
        return new NettyClient(url, listener);
    }
}
{% endhighlight %}

`Transporter`的各个实现都比较简单，上面是`NettyTransporter`的实现，我们可以看到`NettyTransporter`分别用`connect()`和`bind()`创建了对应的`Client`和`Server`实现。需要注意的是，Dubbo的Netty实现有两套，一套是netty4的，还有一套是netty3的，所以在Dubbo中提供了两个`NettyTransporter`实现，对应的`Server`和`Client`也有两套。

### 客户端

Dubbo Transporter层的客户端在和服务端进行通信的时候通过`send()`发送请求，然后通过在`Transporter`创建客户端时传入的`ChannelHandler`事件处理器并通过`send()`返回执行结果。

![client](/assets/images/rpc_2-1.png){:width="60%" hight="60%"}

下面我们就以`NettyClient`的实现为例分析下Dubbo是如何用Netty框架实现客户端的，以及如何将Dubbo定义的`ChannelHandler`事件处理器适配到Netty的`ChannelHandler`上的。

#### Client
首先，我们看下Dubbo的客户端`Client`的定义。Dubbo的`Client`类继承了`Endpoint`和`Channel`接口：

{% highlight java %}
public interface Client extends Endpoint, Channel, Resetable, IdleSensible {
    void reconnect() throws RemotingException;

    @Deprecated
    void reset(org.apache.dubbo.common.Parameters parameters);

}

public interface Endpoint {
    URL getUrl();
    ChannelHandler getChannelHandler(); // 1
    InetSocketAddress getLocalAddress(); // 2
    void send(Object message) throws RemotingException; // 3
    void send(Object message, boolean sent) throws RemotingException;
    void close();
    void close(int timeout);
    void startClose();
    boolean isClosed();
}

public interface Channel extends Endpoint {
    InetSocketAddress getRemoteAddress(); // 4
    boolean isConnected();
    boolean hasAttribute(String key);
    Object getAttribute(String key);
    void setAttribute(String key, Object value);
    void removeAttribute(String key);
}
{% endhighlight %}

1. `getChannelHandler`用于获取`Channel`相关的`ChannelHandler`。
2. `getLocalAddress()`获取本地的网络地址。
3. `send()`方法提供了向对端发送数据的入口。
4. `getRemoteAddress()`获取对端的网络地址。

#### AbstractClient
Dubbo对每个通信框架都实现了对应的Client，所有的Client实现都继承了`AbstractClient`这个抽象类。由于和服务端建立连接的过程是通用的，`AbstractClient`通过 **模板方法模式**[^2] 将客户端连接服务端的流程进行统一实现，通过`doOpen()`和`doConnect()`等抽象方法将特定于通信框架的实现逻辑交给具体的子类实现，达到了很好的扩展性：未来需要引入新的通信框架的时候只需要实现子类就可以了。

{% highlight java %}
public abstract class AbstractClient extends AbstractEndpoint implements Client {
  public AbstractClient(URL url, ChannelHandler handler) throws RemotingException {
      super(url, handler);
      needReconnect = url.getParameter(Constants.SEND_RECONNECT_KEY, false);

      try {
          doOpen();   // 1
      } catch (Throwable t) {
          close();
          /* 省略 */
      }
      try {
          // connect.
          connect();  // 2
          /* 省略 */
      } catch (RemotingException t) {
          if (url.getParameter(Constants.CHECK_KEY, true)) {
              close();
              throw t;
          } else {
            /* 省略 */
          }
      } catch (Throwable t) {
          close();
          /* 省略 */
      }
      /* 省略 */
  }
  
  protected void connect() throws RemotingException {
    connectLock.lock();
    try {
        if (isConnected()) {
            return;
        }
        doConnect(); // 3
        if (!isConnected()) {
            throw new RemotingException(this, "Failed connect to server " + getRemoteAddress() + " from " + getClass().getSimpleName() + " "
                    + NetUtils.getLocalHost() + " using dubbo version " + Version.getVersion()
                    + ", cause: Connect wait timeout: " + getConnectTimeout() + "ms.");
        } else {
          /* 省略 */
        }
    } catch (RemotingException e) {
        throw e;
    } catch (Throwable e) {
      /* 省略 */
    } finally {
        connectLock.unlock();
    }
  }
  
  protected abstract void doOpen() throws Throwable;
  protected abstract void doConnect() throws Throwable;
}
{% endhighlight %}

1. 在创建Client的时候，首先通过`doOpen()`启动客户端，具体的启动逻辑则由`AbstractClient`的子类实现。
2. 启动客户端以后，通过`connent()`连接服务端。
3. 在`connect()`中通过`doConnect()`将连接服务端的逻辑由具体的通信框架实现。

由于篇幅原因，这里我们只接受了创建连接的过程，关于关闭和重建连接的过程留给各位同学自行分析。下面我们分析下NettyClient是如何创建连接以及如何Dubbo是如何`ChannelHandler`适配到到Netty的`ChannelHandler`的。

#### NettyClient
Netty框架对应的Client实现有两个，分别对应了Netty3和Netty4的实现。

* `org.apache.dubbo.remoting.transport.netty.NettyClient`
* `org.apache.dubbo.remoting.transport.netty4.NettyClient`

下面，我们以Netty3为例介绍下Client的具体实现。首先看下`NettyClient`打开客户端的逻辑：

{% highlight java %}
protected void doOpen() throws Throwable {
    NettyHelper.setNettyLoggerFactory();
    bootstrap = new ClientBootstrap(CHANNEL_FACTORY); // 1
    bootstrap.setOption("keepAlive", true); // 2
    bootstrap.setOption("tcpNoDelay", true); // 2
    bootstrap.setOption("connectTimeoutMillis", getConnectTimeout()); // 2
    final NettyHandler nettyHandler = new NettyHandler(getUrl(), this); // 3
    bootstrap.setPipelineFactory(new ChannelPipelineFactory() { // 4
        @Override
        public ChannelPipeline getPipeline() {
            NettyCodecAdapter adapter = new NettyCodecAdapter(getCodec(), getUrl(), NettyClient.this); // 5
            ChannelPipeline pipeline = Channels.pipeline();
            pipeline.addLast("decoder", adapter.getDecoder()); // 5
            pipeline.addLast("encoder", adapter.getEncoder()); // 5
            pipeline.addLast("handler", nettyHandler); // 6
            return pipeline;
        }
    });
}
{% endhighlight %}

1. 创建了一个`ClientBootstrap`启动构造器用于创建一个Netty客户端。
2. 设置Netty客户端的Socket options，这里启用了`keepAlive`和`tcpNoDelay`选项，并且设置了连接超时时间，超时时间通过`getConnectTimeout()`获取。`getConnectTimeout()`定义在父类`AbstractEndpoint`中，通过`connect.timeout`配置获取连接超时时间，默认值为3000毫秒。
3. 创建Netty的`ChannelHandler`实现`NettyHandler`。`NettyHandler`继承了`SimpleChannelHandler`。在`NettyHandler`中将Dubbo自己定义的`ChannelHandler`适配成Netty的`ChannelHandler`。这里由于`NettyClient`的父类`AbstractClient`实现了`ChannelHandler`接口，所以Client本身也是一个`ChannelHandler`实现，只不过将`ChannelHandler`委托给了在创建时传入的`ChannelHandler`实现而已，所以在创建`NettyHandler`的时候将`this`指针作为`ChannelHandler`的参数传入。这里实现者没有明示，但是实际上这里运用到了 **适配器模式（Adapter Pattern）**[^3]，将Dubbo自己定义的`ChannelHandler`适配到了Netty的`ChannelHandler`接口上。
4. 设置Netty的`Channel`的管道抽象工厂实现，用于创建经过组装的`Channel`。Netty中的`ChannelHandler`就是通过管线（pipeline）管理的。
5. 将Dubbo中定义的`Codec`编解码器适配到Netty的编解码处理器，并添加到事件处理的pipeline中。
6. 添加将Dubbo定义的`ChannelHandler`转换后成Netty的`ChannelHandler`的事件处理器。

我们看下`NettyHandler`的实现就会知道，在`NettyHandler`中所有Dubbo定义的`ChannelHandler`中的方法最终都会被Netty的`ChannelHandler`中对应的方法调用。比如下面Netty的`channelConnected`事件处理方法就会调用`ChannelHandler`的`connected()`方法：

{% highlight java %}
public class NettyHandler extends SimpleChannelHandler {
  public void channelConnected(ChannelHandlerContext ctx, ChannelStateEvent e) throws Exception {
      NettyChannel channel = NettyChannel.getOrAddChannel(ctx.getChannel(), url, handler);
      try {
          if (channel != null) {
              channels.put(NetUtils.toAddressString((InetSocketAddress) ctx.getChannel().getRemoteAddress()), channel);
          }
          handler.connected(channel);
      } finally {
          NettyChannel.removeChannelIfDisconnected(ctx.getChannel());
      }
  }
}
{% endhighlight %}

打开连接的实现如下：

{% highlight java %}
protected void doConnect() throws Throwable {
    long start = System.currentTimeMillis();
    ChannelFuture future = bootstrap.connect(getConnectAddress()); // 1
    try {
        boolean ret = future.awaitUninterruptibly(getConnectTimeout(), TimeUnit.MILLISECONDS);

        if (ret && future.isSuccess()) {
            Channel newChannel = future.getChannel(); // 2
            newChannel.setInterestOps(Channel.OP_READ_WRITE);
            try {
                // Close old channel
                Channel oldChannel = NettyClient.this.channel; // copy reference
                if (oldChannel != null) {
                    try {
                        if (logger.isInfoEnabled()) {
                            logger.info("Close old netty channel " + oldChannel + " on create new netty channel " + newChannel);
                        }
                        oldChannel.close();
                    } finally {
                        NettyChannel.removeChannelIfDisconnected(oldChannel); // 3
                    }
                }
            } finally {
                if (NettyClient.this.isClosed()) {
                    try {
                        if (logger.isInfoEnabled()) {
                            logger.info("Close new netty channel " + newChannel + ", because the client closed.");
                        }
                        newChannel.close();
                    } finally {
                        NettyClient.this.channel = null;
                        NettyChannel.removeChannelIfDisconnected(newChannel);
                    }
                } else {
                    NettyClient.this.channel = newChannel;
                }
            }
        } else if (future.getCause() != null) {
            throw new RemotingException(this, "client(url: " + getUrl() + ") failed to connect to server "
                    + getRemoteAddress() + ", error message is:" + future.getCause().getMessage(), future.getCause());
        } else {
            throw new RemotingException(this, "client(url: " + getUrl() + ") failed to connect to server "
                    + getRemoteAddress() + " client-side timeout "
                    + getConnectTimeout() + "ms (elapsed: " + (System.currentTimeMillis() - start) + "ms) from netty client "
                    + NetUtils.getLocalHost() + " using dubbo version " + Version.getVersion());
        }
    } finally {
        if (!isConnected()) {
            future.cancel();
        }
    }
}
{% endhighlight %}

1. 调用Netty的`connect()`方法向服务端发起连接。由于Netty是一个异步IO框架，所以会立即返回并返回一个`ChannelFuture`对象。
2. 通过`ChannelFuture`获取到异步创建完成的`Channel`，如果存在就的`Channel`对象，则需要更新旧的`Channel`对象，这里考虑到并发更新的情况，所以将`channel`成员变量修饰了`volatile`关键字。
3. 通过`removeChannelIfDisconnected`同步删除`NettyChannel`中存储的过时的`Channel`对象。

Dubbo自己定义的`Channel`对象通过`getChannel()`方法创建，在`getChannel()`方法中通过`NettyChannel`的`getOrAddChannel()`方法将Netty的`Channel`对象包装成一个Dubbo的`Channel`实现`NettyChannel`并返回：

{% highlight java %}
final class NettyChannel extends AbstractChannel {
  static NettyChannel getOrAddChannel(org.jboss.netty.channel.Channel ch, URL url, ChannelHandler handler) {
      if (ch == null) {
          return null;
      }
      NettyChannel ret = CHANNEL_MAP.get(ch);
      if (ret == null) {
          NettyChannel nc = new NettyChannel(ch, url, handler); // 1
          if (ch.isConnected()) {
              ret = CHANNEL_MAP.putIfAbsent(ch, nc);
          }
          if (ret == null) {
              ret = nc;
          }
      }
      return ret;
  }
}
{% endhighlight %}

1. 创建一个新的`NettyChannel`实例并返回，在`NettyChannel`中包装了Netty的`Channel`对象和Dubbo定义的`ChannelHandler`对象。我们通过`NettyChannel`的`send()`方法可以看到Dubbo是如何将`Channel`的`send()`请求委托给Netty的`write()`操作的：

{% highlight java %}
public void send(Object message, boolean sent) throws RemotingException {
    super.send(message, sent);

    boolean success = true;
    int timeout = 0;
    try {
        ChannelFuture future = channel.write(message); // 1
        if (sent) {
            timeout = getUrl().getPositiveParameter(TIMEOUT_KEY, DEFAULT_TIMEOUT);
            success = future.await(timeout);
        }
        Throwable cause = future.getCause();
        if (cause != null) {
            throw cause;
        }
    } catch (Throwable e) {
        throw new RemotingException(this, "Failed to send message " + message + " to " + getRemoteAddress() + ", cause: " + e.getMessage(), e);
    }

    if (!success) {
        throw new RemotingException(this, "Failed to send message " + message + " to " + getRemoteAddress()
                + "in timeout(" + timeout + "ms) limit");
    }
}
{% endhighlight %}

1. `send()`方法内部调用Netty的`Channel.write()`方法将消息写到网络上。

![client](/assets/images/rpc_2-2.png){:width="60%" hight="60%"}

上图是Dubbo的`NettyClient`客户端实现如何和Netty框架交互的示意图。鉴于篇幅原因，我们就不再逐个介绍针对不同通信框架的Client实现了，大家只要知道了具体的实现原理，剩下`MinaClient`、`GrizzlyClient`以及netty4实现的`NettyClient`留给大家自行分析。下面，我们来分析下服务端Server的实现。

### 服务端

Dubbo的Transporter层服务端由`Server`类实现，通过`Transporter`的`bind()`方法创建。和客户端实现一样，Dubbo也提供了多种基于不同IO框架实现的服务端。服务端通过`ChannelHandler`接受来自服务端的请求，通过`Channel`的`send()`方法向客户端返回请求结果。

#### Server

`Server`类继承了`Endpoint`接口，`isBound()`方法用于判断服务端是否绑定了地址。`getChannel()`用于获取客户端创建的连接，用于后续向客户端发送信息。

{% highlight java %}
public interface Server extends Endpoint, Resetable, IdleSensible {
    boolean isBound();

    Collection<Channel> getChannels();

    Channel getChannel(InetSocketAddress remoteAddress);
}
{% endhighlight %}

#### AbstractServer

和`AbstractClient`一样，Dubbo的服务端也定义了一个`AbstractServer`，将服务端通用的流程在模板类中抽象，然后将需要需要子类实现的方法定义成抽象方法交给具体的子类实现。

{% highlight java %}
public AbstractServer(URL url, ChannelHandler handler) throws RemotingException {
    super(url, handler);
    localAddress = getUrl().toInetSocketAddress();

    String bindIp = getUrl().getParameter(Constants.BIND_IP_KEY, getUrl().getHost());
    int bindPort = getUrl().getParameter(Constants.BIND_PORT_KEY, getUrl().getPort());
    if (url.getParameter(ANYHOST_KEY, false) || NetUtils.isInvalidLocalHost(bindIp)) {
        bindIp = ANYHOST_VALUE;
    }
    bindAddress = new InetSocketAddress(bindIp, bindPort);  // 1
    this.accepts = url.getParameter(ACCEPTS_KEY, DEFAULT_ACCEPTS);
    this.idleTimeout = url.getParameter(IDLE_TIMEOUT_KEY, DEFAULT_IDLE_TIMEOUT);
    try {
        doOpen(); // 2
        if (logger.isInfoEnabled()) {
            logger.info("Start " + getClass().getSimpleName() + " bind " + getBindAddress() + ", export " + getLocalAddress());
        }
    } catch (Throwable t) {
        throw new RemotingException(url.toInetSocketAddress(), null, "Failed to bind " + getClass().getSimpleName()
                + " on " + getLocalAddress() + ", cause: " + t.getMessage(), t);
    }
    /* 省略 */
}
{% endhighlight %}

1. 通过URL获取到服务端绑定的IP地址和端口。
2. 由子类实现的服务启动逻辑。

#### NettyServer

具体的服务启动逻辑在各个子类中实现，下面我们以Netty的实现`NettyServer`为例来看下服务是如何启动的。

{% highlight java %}
protected void doOpen() throws Throwable {
    NettyHelper.setNettyLoggerFactory();
    ExecutorService boss = Executors.newCachedThreadPool(new NamedThreadFactory("NettyServerBoss", true)); // 1
    ExecutorService worker = Executors.newCachedThreadPool(new NamedThreadFactory("NettyServerWorker", true)); // 2
    ChannelFactory channelFactory = new NioServerSocketChannelFactory(boss, worker, getUrl().getPositiveParameter(IO_THREADS_KEY, Constants.DEFAULT_IO_THREADS));
    bootstrap = new ServerBootstrap(channelFactory);

    final NettyHandler nettyHandler = new NettyHandler(getUrl(), this);
    channels = nettyHandler.getChannels(); // 3
    bootstrap.setOption("child.tcpNoDelay", true);  // 4
    bootstrap.setPipelineFactory(new ChannelPipelineFactory() {
        @Override
        public ChannelPipeline getPipeline() {
            NettyCodecAdapter adapter = new NettyCodecAdapter(getCodec(), getUrl(), NettyServer.this);
            ChannelPipeline pipeline = Channels.pipeline();
            pipeline.addLast("decoder", adapter.getDecoder());
            pipeline.addLast("encoder", adapter.getEncoder());
            pipeline.addLast("handler", nettyHandler); // 5
            return pipeline;
        }
    });
    // bind
    channel = bootstrap.bind(getBindAddress());
}
{% endhighlight %}

1. 创建监听网络请求的线程池。
2. 创建IO线程池。
3. 获取从客户端连接到服务端的`Channel`对象，`channels`的值随着客户端连接和断开变化，具体逻辑在`NettyChannel`的`channelConnected()`和`channelDisconnected()`中实现。
4. 关闭`Nagle`算法。
5. 设置处理来自客户端请求的`ChannelHandler`对象。

下图是服务端处理请求的流程：

![client](/assets/images/rpc_2-3.png){:width="60%" hight="60%"}

## Exchanger层

有了Client和Server，两端的通信方式就可以参考在 **Channel** 一节中的那张示意图那样，实现客户端和服务端的通信了。但是，由于Transporter层的通信方式是端到端的，并没有请求和响应的概念，所以Dubbo在Transporter层之上由进行了抽象，添加了Exchanger数据交换层，引入了 **请求-响应** 语义。

Exchange层也定义了客户端和服务端，分别用`ExchangeClient`和`ExchangeServer`表示。Transport层的`Channel`在Exchange层通过`ExchangeChannel`表示。

Transport层是端到端的请求，所以在`Channel`中只提供了一个`send()`方法用于在客户端和服务端之间发送数据。在`ExchangeChannel`中定义了`request()`方法用于发送request请求，不同于`send()`方法，`request()`方法的返回值是一个`CompletableFuture`对象，用于表示一个异步返回的响应。

{% highlight java %}
public interface ExchangeChannel extends Channel {
    CompletableFuture<Object> request(Object request) throws RemotingException;

    CompletableFuture<Object> request(Object request, int timeout) throws RemotingException;

    ExchangeHandler getExchangeHandler();

    @Override
    void close(int timeout);
}
{% endhighlight %}

和Transport层一样，在Exchange层通过`ExchangeHandler`异步处理事件。在`ExchangeHandler`中定义了一个`reply()`方法用于返回服务端的响应结果。在`reply()`方法中返回了一个`CompletableFuture`读写以实现异步返回。

{% highlight java %}
public interface ExchangeHandler extends ChannelHandler, TelnetHandler {
    CompletableFuture<Object> reply(ExchangeChannel channel, Object request) throws RemotingException;
}
{% endhighlight %}

### Exchanger

`Exchanger`类用于创建Exchange层的客户端和服务端。和`Transporter`类似，`bind()`方法用于创建Exchange层的服务端`ExchangeServer`，`connect()`方法用于创建客户端`ExchangeClient`。

{% highlight java %}
@SPI(HeaderExchanger.NAME)
public interface Exchanger {
    @Adaptive({Constants.EXCHANGER_KEY})
    ExchangeServer bind(URL url, ExchangeHandler handler) throws RemotingException;

    @Adaptive({Constants.EXCHANGER_KEY})
    ExchangeClient connect(URL url, ExchangeHandler handler) throws RemotingException;
}
{% endhighlight %}

`Exchanger`实现类只有一个`HeaderExchanger`，我们可以从`HeaderExchanger`中看到创建exchange层的客户端和服务端的过程：

{% highlight java %}
public class HeaderExchanger implements Exchanger {
    public static final String NAME = "header";

    @Override
    public ExchangeClient connect(URL url, ExchangeHandler handler) throws RemotingException {
        return new HeaderExchangeClient(Transporters.connect(url, new DecodeHandler(new HeaderExchangeHandler(handler))), true);  // 1
    }

    @Override
    public ExchangeServer bind(URL url, ExchangeHandler handler) throws RemotingException {
        return new HeaderExchangeServer(Transporters.bind(url, new DecodeHandler(new HeaderExchangeHandler(handler)))); // 2
    }
}
{% endhighlight %}

1. 创建`ExchangeClient`的客户端实现`HeaderExchangeClient`，在创建的时候通过`HeaderExchangeHandler`实现了`ExchangeHandler`向`ChannelHandler`的适配。
2. 创建`ExchangeServer`的客户端实现`HeaderExchangeServer`，在创建的时候通过`HeaderExchangeHandler`实现了`ExchangeHandler`向`ChannelHandler`的适配。

### ExchangeClient

`ExchangeClient`表示Exchanger层的客户端，它本身没有什么特殊的方法，只是继承了`Client`接口。`ExchangeClient`继承了`ExchangeChannel`接口以实现reqeust语义。

{% highlight java %}
public interface ExchangeClient extends Client, ExchangeChannel {
}
{% endhighlight %}

`ExchangeClient`的具体实现类是`HeaderExchangeClient`，在`HeaderExchangeClient`内部通过委托的方式将`request()`调用委托给具体的`ExchangeChannel`实现。

{% highlight java %}
@Override
public CompletableFuture<Object> request(Object request, int timeout) throws RemotingException {
    return channel.request(request, timeout);
}
{% endhighlight %}

*笔者注：Dubbo在这里用委托而不是用继承的方式实现request，应该是为了考虑到组合关系相对于继承关系，组合关系有运行时的动态优势。*

### ExchangeServer

`ExchangeServer`继承了`Server`的接口，同时提供了获取`ExchangeChannel`的方法`getExchangeChannels()`。

{% highlight java %}
public interface ExchangeServer extends Server {
    Collection<ExchangeChannel> getExchangeChannels();

    ExchangeChannel getExchangeChannel(InetSocketAddress remoteAddress);
}
{% endhighlight %}

`ExchangeServer`的是实现是`HeaderExchangeServer`，和`HeaderExchangeClient`一样，它也是通过委托的方式将请求委托给`Server`执行。

{% highlight java %}
@Override
public void send(Object message) throws RemotingException {
    if (closed.get()) {
        throw new RemotingException(this.getLocalAddress(), null, "Failed to send message " + message
                + ", cause: The server " + getLocalAddress() + " is closed!");
    }
    server.send(message);
}

@Override
public void send(Object message, boolean sent) throws RemotingException {
    if (closed.get()) {
        throw new RemotingException(this.getLocalAddress(), null, "Failed to send message " + message
                + ", cause: The server " + getLocalAddress() + " is closed!");
    }
    server.send(message, sent);
}
{% endhighlight %}

`HeaderExchangeServer`在返回`ExchangeChannel`的时候，通过`HeaderExchangeChannel`的`getOrAddChannel()`方法将`Server`返回的`Channel`转换成`ExchangeChannel`。

{% highlight java %}
@Override
public Collection<ExchangeChannel> getExchangeChannels() {
    Collection<ExchangeChannel> exchangeChannels = new ArrayList<ExchangeChannel>();
    Collection<Channel> channels = server.getChannels();
    if (CollectionUtils.isNotEmpty(channels)) {
        for (Channel channel : channels) {
            exchangeChannels.add(HeaderExchangeChannel.getOrAddChannel(channel));
        }
    }
    return exchangeChannels;
}

@Override
public ExchangeChannel getExchangeChannel(InetSocketAddress remoteAddress) {
    Channel channel = server.getChannel(remoteAddress);
    return HeaderExchangeChannel.getOrAddChannel(channel);
}
{% endhighlight %}

`HeaderExchangeChannel`是`ExchangeChannel`的一个实现，在`HeaderExchangeChannel`中会将`ExchangeChannel`的请求委托给`Channel`对象。

{% highlight java %}
final class HeaderExchangeChannel implements ExchangeChannel {
  static HeaderExchangeChannel getOrAddChannel(Channel ch) {
    if (ch == null) {
        return null;
    }
    HeaderExchangeChannel ret = (HeaderExchangeChannel) ch.getAttribute(CHANNEL_KEY); // 1
    if (ret == null) {
        ret = new HeaderExchangeChannel(ch);
        if (ch.isConnected()) {
            ch.setAttribute(CHANNEL_KEY, ret);
        }
    }
    return ret;
  }
  
  @Override
  public void send(Object message, boolean sent) throws RemotingException {
      if (closed) {
          throw new RemotingException(this.getLocalAddress(), null, "Failed to send message " + message + ", cause: The channel " + this + " is closed!");
      }
      if (message instanceof Request
              || message instanceof Response
              || message instanceof String) {
          channel.send(message, sent);  // 2
      } else {
          Request request = new Request();
          request.setVersion(Version.getProtocolVersion());
          request.setTwoWay(false);
          request.setData(message);
          channel.send(request, sent);  // 3
      }
  }
}
{% endhighlight %}

1. `HeaderExchangeChannel`的对象会被存放在`Channel`的`CHANNEL_KEY`命名的属性中。
2. 处理request或response请求
3. 处理非request和response请求，比如：telnet命令。

### 适配ChannelHandler

Exchange层的客户端和服务端由`Exchanger`的实现类`HeaderExchanger`创建，在通过`connect()`和`bind()`创建`ExchangeClient`和`ExchangeServer`的时候，传入的是`ExchangeHandler`对象，而在Transport层中使用的是`ChannelHandler`接口进行请求事件的处理。

{% highlight java %}
@Override
public ExchangeClient connect(URL url, ExchangeHandler handler) throws RemotingException {
    return new HeaderExchangeClient(Transporters.connect(url, new DecodeHandler(new HeaderExchangeHandler(handler))), true);
}

@Override
public ExchangeServer bind(URL url, ExchangeHandler handler) throws RemotingException {
    return new HeaderExchangeServer(Transporters.bind(url, new DecodeHandler(new HeaderExchangeHandler(handler))));
}
{% endhighlight %}

在`ExchangeHandler`中，请求是通过`reply()`进行响应的，而在`ChannelHandler`中则是通过`received()`进行相应的。从`received()`到`reply()`的适配在`HeaderExchangeHandler`中实现：

{% highlight java %}
public class HeaderExchangeHandler implements ChannelHandlerDelegate
  private final ExchangeHandler handler;
  
  /* 省略 */
  
  @Override
  public void received(Channel channel, Object message) throws RemotingException {
      channel.setAttribute(KEY_READ_TIMESTAMP, System.currentTimeMillis());
      final ExchangeChannel exchangeChannel = HeaderExchangeChannel.getOrAddChannel(channel);
      try {
          if (message instanceof Request) { // 1
              // handle request.
              Request request = (Request) message;
              if (request.isEvent()) {
                  handlerEvent(channel, request);
              } else {
                  if (request.isTwoWay()) {
                      handleRequest(exchangeChannel, request); // 2
                  } else {
                      handler.received(exchangeChannel, request.getData());
                  }
              }
          } else if (message instanceof Response) {
              handleResponse(channel, (Response) message); // 3
          } else if (message instanceof String) {
              if (isClientSide(channel)) {
                  Exception e = new Exception("Dubbo client can not supported string message: " + message + " in channel: " + channel + ", url: " + channel.getUrl());
                  logger.error(e.getMessage(), e);
              } else {
                  String echo = handler.telnet(channel, (String) message);
                  if (echo != null && echo.length() > 0) {
                      channel.send(echo);
                  }
              }
          } else {
              handler.received(exchangeChannel, message);
          }
      } finally {
          HeaderExchangeChannel.removeChannelIfDisconnected(channel);
      }
  }
  /* 省略 */
}
{% endhighlight %}

1. 判断消息是request消息还是response消息，对于服务端一侧收到的是request消息 ，在客户端一侧收到的是response消息。
2. 如果是来着客户端的请求，则执行`handleRequest()`方法处理请求。如果不是request则交由`ChannelHandler`处理。`handleRequest()`中实现了`received()`到`reply()`的适配。
3. 如果是来自服务端的响应，则调用`handleResponse()`进行处理响应结果，将返回值向上返回给远程调用的调用方。

*笔者注：Dubbo的实现者在做适配的时候很多地方用到了委托（Delegate）的思想，包括类的命名上也有委托的影子，但是个人认为更好的命名应该是Adapter而不是Delegate，因为这里明确应该是一个适配的过程，而委托是一种实现方式方式（通过组合方式实现Adapter）。*

下面是`handleRequest()`的实现代码：

{% highlight java %}
void handleRequest(final ExchangeChannel channel, Request req) throws RemotingException {
    Response res = new Response(req.getId(), req.getVersion());
    if (req.isBroken()) {
        Object data = req.getData();

        String msg;
        if (data == null) {
            msg = null;
        } else if (data instanceof Throwable) {
            msg = StringUtils.toString((Throwable) data);
        } else {
            msg = data.toString();
        }
        res.setErrorMessage("Fail to decode request due to: " + msg);
        res.setStatus(Response.BAD_REQUEST);

        channel.send(res);
        return;
    }
    // find handler by message class.
    Object msg = req.getData();
    try {
        CompletionStage<Object> future = handler.reply(channel, msg); // 1
        future.whenComplete((appResult, t) -> { // 2
            try {
                if (t == null) {
                    res.setStatus(Response.OK);
                    res.setResult(appResult);
                } else {
                    res.setStatus(Response.SERVICE_ERROR);
                    res.setErrorMessage(StringUtils.toString(t));
                }
                channel.send(res);
            } catch (RemotingException e) {
                logger.warn("Send result to consumer failed, channel is " + channel + ", msg is " + e);
            } finally {
                // HeaderExchangeChannel.removeChannelIfDisconnected(channel);
            }
        });
    } catch (Throwable e) {
        res.setStatus(Response.SERVICE_ERROR);
        res.setErrorMessage(StringUtils.toString(e));
        channel.send(res);
    }
}
{% endhighlight %}

1. 调用`ExchangeHandler`的`reply()`方法，向上讲调用传递到服务暴露方的Invoker。这个过程通过`CompletableFuture`实现了异步调用。
2. 异步转同步，等待`reply()`异步执行完成，完成以后设置服务端的返回值。

## 请求-响应过程
上面我们已经介绍了Dubbo远程通信中Transport层和Exchange层的实现，下面我们从整体上看下请求是如何从客户端发往服务端，并从服务端返回给客户端的。

![remoting](/assets/images/rpc_2-4.png){:width="100%" hight="100%"}

1. 请求从服务消费者Consumer的Invoker开始，调用`Exchanger`的`connect()`方法创建`HeaderExchangeClient`，然后调用`HeaderExchangeClient`的`request()`方法开始向服务提供方发起请求。
2. 在`HeaderExchangeClient`中调用由Transport层创建的`Client`对象的`send()`方法。底层框架（这里以Netty为例）封装的`Client`实现`NettyClient`调用`send()`方法。
3. `NettyClient`将`send()`调用委托给`NettyChannel`中将`send()`方法，调用Netty`Channel`的`write()`方法向网络栈发送数据。
4. 服务提供方Provider的服务端监听到从网络上发送过来的数据，向事件处理器派发`channelRead()`事件。
5. `NettyHandler`将`channelRead()`事件转换成Dubbo自定义的`ChannelHandler`中的`received()`事件，这一步在Transport层中被处理。
6. Transport层将`received()`请求向Exchange层传递，将`ChannelHandler`的`received()`请求转换成`ExchangeHandler`的`handleRequest()`方法。
7. 在Exchange层中调用在Provider暴露服务时注册的`ExchangeHandler`的`reply()`方法并等待执行返回。
8. 当`ExchangeHandler`的`handleReqeust()`方法等待`reply()`返回以后调用`NettyChannel`的`send()`方法将返回结果发送给Netty框架。
9. Netty的`Channel`将`send()`请求转换成`write()`调用向网络栈发送数据。
10. 客户端监听到来自服务端返回的数据，Netty派发`channelRead()`事件。
11. 客户端注册的`NettyHandler`事件处理器处理`channelRead()`事件并将事件转换成Dubbo自定义的`ChannelHandler`的`received()`事件。
12. Transport层中的`ChannelHandler`将`received()`事件向Exchange层转换，将事件交给`HeaderExchangeHandler`的`handleResponse()`方法处理。
13. `handleResponse()`方法中调用`DefaultFuture`的`received()`方法，通知阻塞在`request`调用上的Invoker，实现异步向同步的转换。

上面就是Dubbo中一个远程过程调用在remoting层中的请求流程，这个过程中我们省略了一些相对无关的主题，比如编码和解码，心跳检测，客户端超时重连等等，这些主题我们会在接下来的文章中逐一分析。

## 总结

本文重点介绍了Dubbo remoting层的实现原理和部分源码实现。介绍了了Transport层和Exchange层之间的转换，并且以Netty框架为例介绍remoting层是如何对网络框架进行封装的。最后我们把远程调用过程在remoting层的完整流程做了介绍。

由于篇幅的原因，在本文中我们重点介绍了Dubbo对remoting的设计，关于编码和解码、Dubbo二进制协议、心跳检测以及客户端超时重连的主题我们都没有涉及，在后面的文章中我们将逐一对这些主题进行分析。

[^1]:[https://netty.io/](https://netty.io/)
[^2]:[https://en.wikipedia.org/wiki/Template_method_pattern](https://en.wikipedia.org/wiki/Template_method_pattern)
[^3]:[https://en.wikipedia.org/wiki/Adapter_pattern](https://en.wikipedia.org/wiki/Adapter_pattern)
