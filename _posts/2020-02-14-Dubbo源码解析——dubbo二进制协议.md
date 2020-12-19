---
layout: post
title: Dubbo源码解析——dubbo二进制协议
date: "2020-02-14 20:00:00 +0800"
categories: Dubbo
tags: java Dubbo rpc
published: true
---

## 前言

在前文[《Dubbo源码解析——远程通信》](/2020/02/06/Dubbo源码解析-远程通信)中我们分析了Dubbo的底层通信原理。Dubbo默认的底层通信协议用到了自定义的 **dubbo二进制** 协议，配合上TCP长连接，在短数据报文的场景下有很好的性能表现。本文，我们就来看下Dubbo自定义的二进制协议是如何实现的。

## 报文格式

Dubbo的 **dubbo二进制协议** 的数据报文采用定长的消息头（header）和不定长的消息体（body）组成。协议的消息头长度为16，在消息头中包含了如下信息：

1. 长度为2字节（16bit）的魔法数（Magic Number）。
2. 长度为1bit的标记位，表示报文是请求报文还是响应报文。
3. 长度为1bit的标记位，表示消息是否需要双向返回。
4. 长度为1bit的标记位，标记是否是事件消息。
5. 长度为5bit的消息体序列化方式，用于区分不同的序列化方案。
6. 长度为1个字节（8bit）的消息体状态。
7. 长度为8字节（64bit）的请求ID，用来在一个连接中区分不同的请求。
8. 长度为4字节的（32bit）的消息体长度，消息体最大长度为4G。
9. 可变长度的消息体。

![dubbo-frame](/assets/images/rpc_5-1.png){:width="80%" hight="80%"}

#### 魔法数（Magic Number）

**dubbo二进制协议** 报文中的魔法数占据2个字节，固定值为`0xdabb`，表示这是一个dubbo协议。按照大端字节序存放：高位存放`0xda`，低位存放`0xbb`。

#### 报文类型标记

紧跟着魔法数字段后面的是报文中仅有的三个标记字段，各占一个bit位。首先第一个标记字段`Req/Res`用于表示报文是请求报文还是响应报文。

* 1 - 请求报文
* 0 - 响应报文

#### 2-way标记

第二个标记位是2way标记，当报文类型是请求报文的时候改标记才有效，用于表示服务端是否需要返回一个值。

#### 事件请求

最后一个标记位是event标记，用于标记报文是否是一个特殊的事件消息报文。如果`event`位被置为1，则表示报文是一个事件报文，比如心跳事件的请求报文，`event`位被标记为1。

#### 序列化ID

报文的第三个字节，除了状态位占据的3位（bit）以外，剩下的5bit用于表示报文中消息体数据的序列化方式。Dubbo目前支持16种序列化方式，默认采用的是hessian2序列化方案，该字段的值为2。

| 值 | 序列化方案 |
| -- | -------- |
| 2 | Hessian2序列化方案，基于原生Hessian修改，性能更好 |
| 3 | Java序列化方案，在Java原生的序列化方案上做了优化 |
| 4 | 类似于Java序列化方案，但是更加紧凑 |
| 6 | Fastjson实现的json序列化方案 |
| 7 | Java原生的序列化方案 |
| 8 | Kryo序列化方案 |
| 9 | FST序列化方案 |
| 10 | 原生的Hessian序列化方案 |
| 11 | Avro序列化方案 |
| 12 | Protostuff 序列化方案 |
| 16 | Gson实现的json序列化方案 |
| 21 | Protobuf-json序列化方案 |

#### 状态位

第四个字节表示报文的响应状态，当`Req/Res`为0的时候，也就是在响应报文中该字段才有用。协议定义了10种响应状态。

| status值 | 描述 |
| -------- + --- |
| 20 | OK |
| 30 | CLIENT_TIMEOUT |
| 31 | SERVER_TIMEOUT |
| 40 | BAD_REQUEST |
| 50 | BAD_RESPONSE |
| 60 | SERVICE_NOT_FOUND |
| 70 | SERVICE_ERROR |
| 80 | SERVER_ERROR |
| 90 | CLIENT_ERROR |
| 100 | SERVER_THREADPOOL_EXHAUSTED_ERROR |

#### 请求ID

Long类型的请求ID，占据8个字节。用于标识一个连接中的请求，在实现中通过自增ID的方式实现，在一个连接中唯一。用于在客户端中识别响应的请求。

#### 数据长度

跟在请求ID后面的是长度为4个字节的数据体长度。

#### 可变部分

数据体部分是一个序列化后的可变长度的字节数组。长度由报文中的数据长度（Data Length）控制。序列化方式由报文中的序列化ID（Serialization ID）表示。

1. 请求报文的消息体如下定义：
  * Dubbo版本
  * 服务名称
  * 服务版本
  * 方法名称
  * 方法参数类型名称（Java统一命名规范中定义的名称，比如Integer数组类型`[Ljava.lang.Integer`）
  * 方法参数列表
  * 附件（Attachments）
2. 响应报文的消息体定义：
  * 响应类型：2 - RESPONSE_NULL_VALUE；1 - RESPONSE_VALUE；0 - RESPONSE_WITH_EXCEPTION
  * 返回值

上述这些信息都通过序列化以后存放在报文中。

## 编码和解码

上文中我们介绍了 **dubbo二进制协议** 的报文格式。报文格式的目的是在客户端和服务端之间定义数据传递的格式，规范在客户端和服务端处理的数据。

在Dubbo中，应用层使用的数据是通过POJO封装的Java对象，比如表示请求的`Request`对象和表示响应的`Response`对象。这些数据在发送到网络对端的时候需要经过网络层传输，网络层的数据是以协议定义二进制流的格式传输的，也就是按照我们上面提到的报文格式传输数据。

那么Dubbo是如何将POJO对象转换成报文格式，以及从传输层接收数据的时候又是如何将报文转换成POJO对象的呢？下面，我们就来看下Dubbo的编码和解码过程。

## 编码

首先，网络中的数据传递是以二进制流的方式传递的，那么我们如果要讲一个Java对象放到网络上传输，那么我们就需要将Java对象转换成二进制流的，这个过程称为 **编码（encode）**。

![encode](/assets/images/rpc_5-2.png){:width="40%" hight="40%"}

Dubbo提供了`Codec2`编解码器对编码做了抽象。通过实现`Codec2`接口来实现编码逻辑。

{% highlight java %}
public interface Codec2 {
    @Adaptive({Constants.CODEC_KEY})
    void encode(Channel channel, ChannelBuffer buffer, Object message) throws IOException;

    /* 省略 */
}
{% endhighlight %}

`encode()`方法将Java对象`message`编码成字节流存储在`buffer`中。`ChannelBuffer`是Dubbo自定义的一个字节缓冲区，实现照搬了Netty的`ByteBuf`。

![codec-class-diagram](/assets/images/rpc_5-3.png){:width="60%" hight="60%"}

Dubbo二进制协议的编解码器`DubboCodec`继承自`ExchangeCodec`。`ExchangeCodec`实现了`Codec2`接口，在`ExchangeCodec`的`encode()`方法中实现了完整的编码过程：

{% highlight java %}
public class ExchangeCodec extends TelnetCodec {
  public void encode(Channel channel, ChannelBuffer buffer, Object msg) throws IOException {
      if (msg instanceof Request) {
          encodeRequest(channel, buffer, (Request) msg);
      } else if (msg instanceof Response) {
          encodeResponse(channel, buffer, (Response) msg);
      } else {
          super.encode(channel, buffer, msg);
      }
  }
}
{% endhighlight %}

在`ExchangeCodec`的`encode()`方法中，检查消息类型是`Request`还是`Response`消息，分别调用`encodeRequest()`和`encodeResponse()`方法对消息对象进行编码。下面我们来分别分析下这两个编码过程。

### 编码Request对象

下面我们来看下对请求信息进行编码的过程，首先是被编码请求对象`Request`的定义：

{% highlight java %}
public class Request {
    public static final String HEARTBEAT_EVENT = null;
    public static final String READONLY_EVENT = "R";
    private static final AtomicLong INVOKE_ID = new AtomicLong(0);
    private final long mId;
    private String mVersion;
    private boolean mTwoWay = true;
    private boolean mEvent = false;
    private boolean mBroken = false;
    private Object mData;
    
    /* 省略 setter 和 getter 方法 */
}
{% endhighlight %}

下面是`Request`对象编码成字节流的逻辑：

{% highlight java %}
protected void encodeRequest(Channel channel, ChannelBuffer buffer, Request req) throws IOException {
    Serialization serialization = getSerialization(channel); // 1
    // header.
    byte[] header = new byte[HEADER_LENGTH]; // 2
    // set magic number.
    Bytes.short2bytes(MAGIC, header); // 3

    // set request and serialization flag.
    header[2] = (byte) (FLAG_REQUEST | serialization.getContentTypeId()); // 4

    if (req.isTwoWay()) { // 5
        header[2] |= FLAG_TWOWAY;
    }
    if (req.isEvent()) { // 6
        header[2] |= FLAG_EVENT;
    }

    // set request id.
    Bytes.long2bytes(req.getId(), header, 4); // 7

    // encode request data.
    int savedWriteIndex = buffer.writerIndex();
    buffer.writerIndex(savedWriteIndex + HEADER_LENGTH);
    ChannelBufferOutputStream bos = new ChannelBufferOutputStream(buffer);
    ObjectOutput out = serialization.serialize(channel.getUrl(), bos); // 8
    if (req.isEvent()) {
        encodeEventData(channel, out, req.getData()); // 9
    } else {
        encodeRequestData(channel, out, req.getData(), req.getVersion()); // 10
    }
    out.flushBuffer();
    if (out instanceof Cleanable) {
        ((Cleanable) out).cleanup();
    }
    bos.flush();
    bos.close();
    int len = bos.writtenBytes();
    checkPayload(channel, len);
    Bytes.int2bytes(len, header, 12);

    // write
    buffer.writerIndex(savedWriteIndex); // 11
    buffer.writeBytes(header); // write header. // 11
    buffer.writerIndex(savedWriteIndex + HEADER_LENGTH + len); // 11
}
{% endhighlight %}

1. 通过`Channel`的`URL`获取到序列化的配置，序列化方案可以通过`serialization`参数进行配置，如果没有指定则默认使用`hessian2`序列化机制。
2. 分配存放数据包头部的字节数组，`HEADER_LENGTH`的大小为dubbo协议的协议头长度，16字节。
3. 首先将dubbo协议的魔法数`MAGIC`写入协议头的字节数组中，值为`0xdabb`。
4. 设置协议头的请求类型，也就是Req/Res标记位的值，这里设置为`FLAG_REQUEST = 1`。然后把序列化方式写入协议头的第三个字节的低5位中。
5. 判断请求是否是`two-way`请求，如果是则将标志位置为1。
6. 判断请求是否是事件请求，如果是则将标志位置为1。
7. 将long类型的请求ID写入协议头，请求ID是一个定义在`Request`对象中的`INVOKE_ID`成员生成的自增ID。`INVOKE_ID`是一个`AtomicLong`类型的静态成员变量，所以可以认为请求ID是JVM内部唯一的。由于请求是和网络连接关联的，所以JVM内部唯一就可以保证集群内不冲突（类似于TCP的Seq）。
8. 生成对象序列化的输出流。
9. 判断请求类型是否是事件类型，如果是则通过`encodeEventData`对数据包的消息体部分进行编码，这个过程涉及到Java对象的序列化过程，通过`out.writeObject()`进行序列化操作。
10. 如果请求类型是普通的请求，则通过`encodeRequestData()`对数据包的消息体部分进行编码，这个过程涉及到Java对象的序列化。`DubboCodec`对`encodeRequestData()`进行了重写以实现Dubbo的消息体编码逻辑。
11. 将消息的头部和消息体封装到一个字节缓冲区中。完成对`Request`消息的编码。

### 编码Response对象

介绍完对`Request`对象的编码过程，我们下面来看下对`Response`对象的编码过程。对`Response`的编码过程由`DubboCodec`重写的`encodeRequestData()`方法实现，代码如下：

{% highlight java %}
public class DubboCodec extends ExchangeCodec {
  protected void encodeRequestData(Channel channel, ObjectOutput out, Object data, String version) throws IOException {
      RpcInvocation inv = (RpcInvocation) data; // 1

      out.writeUTF(version); // 2
      out.writeUTF(inv.getAttachment(PATH_KEY)); // 3
      out.writeUTF(inv.getAttachment(VERSION_KEY)); // 4

      out.writeUTF(inv.getMethodName()); // 5
      out.writeUTF(ReflectUtils.getDesc(inv.getParameterTypes())); // 6
      Object[] args = inv.getArguments();
      if (args != null) {
          for (int i = 0; i < args.length; i++) {
              out.writeObject(encodeInvocationArgument(channel, inv, i)); // 7
          }
      }
      out.writeObject(inv.getAttachments()); // 8
  }
}
{% endhighlight %}

这部分编码对应了我们上面提到的消息体可变部分的数据：

1. 获取远程调用的调用上下文`RpcInvocation`。
2. 将Dubbo版本字符串序列化到消息体中。
3. 将服务名称字符串序列化到消息体中。
4. 将服务的版本字符串序列化到消息体中。
5. 将方法名称字符串序列化到消息体中。
6. 将方法参数类型的描述字符串序列化到消息体中。
7. 将方法的参数对象序列化到消息体中。
8. 将附件（Attachment）中的内容序列化到消息体中。

上面的过程就是Dubbo对请求对象`Request`进行编码的过程，下面我们来看下响应对象`Response`的编码过程：

{% highlight java %}
protected void encodeResponse(Channel channel, ChannelBuffer buffer, Response res) throws IOException {
    int savedWriteIndex = buffer.writerIndex();
    try {
        Serialization serialization = getSerialization(channel); // 1
        // header.
        byte[] header = new byte[HEADER_LENGTH]; // 2
        // set magic number.
        Bytes.short2bytes(MAGIC, header); // 3
        // set request and serialization flag.
        header[2] = serialization.getContentTypeId(); // 4
        if (res.isHeartbeat()) { // 5
            header[2] |= FLAG_EVENT;
        }
        // set response status.
        byte status = res.getStatus();
        header[3] = status; // 6
        // set request id.
        Bytes.long2bytes(res.getId(), header, 4); // 7

        buffer.writerIndex(savedWriteIndex + HEADER_LENGTH);
        ChannelBufferOutputStream bos = new ChannelBufferOutputStream(buffer);
        ObjectOutput out = serialization.serialize(channel.getUrl(), bos);
        // encode response data or error message.
        if (status == Response.OK) { // 8
            if (res.isHeartbeat()) {
                encodeHeartbeatData(channel, out, res.getResult());
            } else {
                encodeResponseData(channel, out, res.getResult(), res.getVersion());
            }
        } else {
            out.writeUTF(res.getErrorMessage());
        }
        out.flushBuffer();
        if (out instanceof Cleanable) {
            ((Cleanable) out).cleanup();
        }
        bos.flush();
        bos.close();

        int len = bos.writtenBytes();
        checkPayload(channel, len);
        Bytes.int2bytes(len, header, 12);
        // write
        buffer.writerIndex(savedWriteIndex); // 9
        buffer.writeBytes(header); // write header.
        buffer.writerIndex(savedWriteIndex + HEADER_LENGTH + len);
    } catch (Throwable t) {
      /* 省略 */
    }
}
{% endhighlight %}

1. 和`encodeRequest()`一样，通过url获取到序列化方案的配置。
2. 分配容纳dubbo协议的协议头大小的字节数组，大小为16字节。
3. 将魔法数`0xdabb`写入协议头数组中。
4. 将序列化方案写入协议头数组中。
5. 判断响应类型是否是心跳检测响应，如果是的话将协议头中的`event`标记位置1。
6. 获取响应的状态，并将状态写入协议头中。
7. 写入响应的请求ID，该请求ID对应了本次响应对应的那个请求的请求ID。
8. 判断响应是否成功，如果成功则对响应中的数据部分进行序列化并存入数据包的消息体中，否则将错误信息序列化到数据包消息体中。这里对成功响应的数据体进行序列化的时候，需要区分是普通请求的响应还是心跳事件的响应，分别调用`encodeResponseData()`和`encodeHeartbeatData()`。
9. 组装响应的头部和消息体，组成完整的数据包。

下面，我们来看下`encodeResponseData()`是如何对消息返回的数据进行编码的。`encodeResponseData()`被`DubboCodec`重写，在`DubboCodec`中实现了dubbo协议响应消息体的编码逻辑。

{% highlight java %}
public class DubboCodec extends ExchangeCodec {
    protected void encodeResponseData(Channel channel, ObjectOutput out, Object data, String version) throws IOException {
        Result result = (Result) data;
        // currently, the version value in Response records the version of Request
        boolean attach = Version.isSupportResponseAttachment(version);
        Throwable th = result.getException();
        if (th == null) { // 1
            Object ret = result.getValue();
            if (ret == null) { // 2
                out.writeByte(attach ? RESPONSE_NULL_VALUE_WITH_ATTACHMENTS : RESPONSE_NULL_VALUE);
            } else { // 2
                out.writeByte(attach ? RESPONSE_VALUE_WITH_ATTACHMENTS : RESPONSE_VALUE);
                out.writeObject(ret);
            }
        } else {
            out.writeByte(attach ? RESPONSE_WITH_EXCEPTION_WITH_ATTACHMENTS : RESPONSE_WITH_EXCEPTION); // 1
            out.writeObject(th);
        }

        if (attach) { // 3
            // returns current version of Response to consumer side.
            result.getAttachments().put(DUBBO_VERSION_KEY, Version.getProtocolVersion());
            out.writeObject(result.getAttachments());
        }
    }
}
{% endhighlight %}

1. 判断响应是否有异常，如果有异常则在返回的消息体中设置`RESPONSE_WITH_EXCEPTION`或`RESPONSE_WITH_EXCEPTION_WITH_ATTACHMENTS`状态值，并将异常对象序列化到消息体中，作为返回值返回给请求端。
2. 如果响应正常，则基于返回值是否为NULL设置不同的响应状态：如果响应的结果是`NULL`，则将状态设置为`RESPONSE_NULL_VALUE_WITH_ATTACHMENTS`或`RESPONSE_NULL_VALUE`；如果响应结果不是`NULL`值，则设置响应状态为`RESPONSE_VALUE_WITH_ATTACHMENTS`或`RESPONSE_VALUE`，并将结果序列化到消息体中。
3. 如果有附件，则将附件也序列化到消息体中。

## 解码

上面我们分析了在应用层的对象转换成字节流的过程，这个过程通过编码的方式处理。现在，我们需要将从网络中获取到的字节流传递给应用层，这个过程需要将字节流转换成请求或响应对象。从字节流向对象转换的过程称为 **解码（decode）**。

![decode](/assets/images/rpc_5-4.png){:width="40%" hight="40%"}

解码过程由`Codec2`的`decode()`方法定义，dubbo协议的解码逻辑则有实现类`ExchangeCodec`的`decode()`方法实现。

{% highlight java %}
public interface Codec2 {
    @Adaptive({Constants.CODEC_KEY})
    Object decode(Channel channel, ChannelBuffer buffer) throws IOException;

    enum DecodeResult {
        NEED_MORE_INPUT, SKIP_SOME_INPUT
    }
}
{% endhighlight %}

`Codec2`中的`DecodeResult`用于控制在编码过程中的编码进度，由于Dubbo使用TCP协议进行网络传输，TCP是一个流协议，数据包的数据流到达的时候可能不是完整的数据包，这个时候编码过程就需要等待数据完全达到以后才能继续进行，而`DecodeResult`就是用来控制这个过程的，其中`SKIP_SOME_INPUT`目前还没有用到。

下面，我们来看下`ExchangeCodec`是如何实现协议的解码过程的：

{% highlight java %}
public class ExchangeCodec extends TelnetCodec {
  @Override
  public Object decode(Channel channel, ChannelBuffer buffer) throws IOException {
    int readable = buffer.readableBytes();
    byte[] header = new byte[Math.min(readable, HEADER_LENGTH)];
    buffer.readBytes(header);
    return decode(channel, buffer, readable, header);
  }
}

@Override
protected Object decode(Channel channel, ChannelBuffer buffer, int readable, byte[] header) throws IOException {
    // check magic number.
    if (readable > 0 && header[0] != MAGIC_HIGH
            || readable > 1 && header[1] != MAGIC_LOW) { // 1
        int length = header.length;
        if (header.length < readable) {
            header = Bytes.copyOf(header, readable);
            buffer.readBytes(header, length, readable - length);
        }
        for (int i = 1; i < header.length - 1; i++) {
            if (header[i] == MAGIC_HIGH && header[i + 1] == MAGIC_LOW) {
                buffer.readerIndex(buffer.readerIndex() - header.length + i);
                header = Bytes.copyOf(header, i);
                break;
            }
        }
        return super.decode(channel, buffer, readable, header);
    }
    // check length.
    if (readable < HEADER_LENGTH) {
        return DecodeResult.NEED_MORE_INPUT; // 2
    }

    // get data length.
    int len = Bytes.bytes2int(header, 12); // 3
    checkPayload(channel, len); // 3

    int tt = len + HEADER_LENGTH;
    if (readable < tt) {
        return DecodeResult.NEED_MORE_INPUT; // 4
    }

    // limit input stream.
    ChannelBufferInputStream is = new ChannelBufferInputStream(buffer, len);

    try {
        return decodeBody(channel, is, header); // 5
    } finally {
        if (is.available() > 0) {
            try {
                if (logger.isWarnEnabled()) {
                    logger.warn("Skip input stream " + is.available());
                }
                StreamUtils.skipUnusedStream(is);
            } catch (IOException e) {
                logger.warn(e.getMessage(), e);
            }
        }
    }
}
{% endhighlight %}

1. 判断返回的数据头的魔法数是否是dubbo协议定义的`0xdabb`，如果不是则表示不是dubbo协议的数据包，扔给父类处理。
2. 判断当前读取到的字节数据的数量是否满足dubbo协议的协议头规定的字节数，如果不满足则返回`NEED_MORE_INPUT`，表示需要更多的数据来支持解码过程。解码器是一个有状态的对象，通过前面提到的`DecodeResult`来控制行为，通过不断喂给（feed）解码器数据以完成解码，如果解码过程中发现数据缺失，则返回`NEED_MORE_INPUT`以等待更多的数据输入。这个循环的过程我们会在下面介绍适配通信框架的编解码器到的时候看到。
3. 从消息头的字节流中解码出数据包消息体的长度，通过`checkPayload()`检查收到的消息体的长度是否超过了配置的载荷的最大值。载荷的最大值通过参数`payload`配置，默认大小为8M。
4. 检查当前已经接收到的字节数据是否能满足一个数据包的长度，如果不满足则返回`NEED_MORE_INPUT`，表示需要读取更多的数据。
5. 当接收到的数据量已经满足对数据体进行解码的时候，调用`decodeBody()`进行解码操作。`DubboCodec`覆写了`decodeBody()`方法来实现dubbo协议的数据包解码逻辑。

### 解码Request对象

下面我们来看下`DubboCodec`的`decodeBody()`实现。`decodeBody()`中包含了对请求和响应数据包的解码逻辑，我们先看下对请求数据包的解码。

{% highlight java %}
protected Object decodeBody(Channel channel, InputStream is, byte[] header) throws IOException {
    byte flag = header[2], proto = (byte) (flag & SERIALIZATION_MASK); // 1
    // get request id.
    long id = Bytes.bytes2long(header, 4); // 2
    if ((flag & FLAG_REQUEST) == 0) {
      /* 省略 */
    } else {
        // decode request.
        Request req = new Request(id); // 3
        req.setVersion(Version.getProtocolVersion()); // 4
        req.setTwoWay((flag & FLAG_TWOWAY) != 0); // 4
        if ((flag & FLAG_EVENT) != 0) {
            req.setEvent(true); // 5
        }
        try {
            Object data;
            ObjectInput in = CodecSupport.deserialize(channel.getUrl(), is, proto); // 6
            if (req.isHeartbeat()) {
                data = decodeHeartbeatData(channel, in); // 7
            } else if (req.isEvent()) {
                data = decodeEventData(channel, in); // 7
            } else {
                DecodeableRpcInvocation inv;
                if (channel.getUrl().getParameter(DECODE_IN_IO_THREAD_KEY, DEFAULT_DECODE_IN_IO_THREAD)) { // 8
                    inv = new DecodeableRpcInvocation(channel, req, is, proto);
                    inv.decode();
                } else {
                    inv = new DecodeableRpcInvocation(channel, req,
                            new UnsafeByteArrayInputStream(readMessageData(is)), proto); // 8
                }
                data = inv; // 9
            }
            req.setData(data);
        } catch (Throwable t) {
            if (log.isWarnEnabled()) {
                log.warn("Decode request failed: " + t.getMessage(), t);
            }
            // bad request
            req.setBroken(true);
            req.setData(t);
        }
        return req;
    }
}
{% endhighlight %}

1. 首先从数据包的header中获取数据包的类型是请求数据包还是响应数据包，然后从header中获取序列化方式以便在后面对数据体中的数据进行反序列化。
2. 从header中获取请求ID，用于标识请求对象。
3. 创建`Request`对象，并用请求ID初始化。
4. 从header中获取dubbo协议的版本和`two-way`标记，设置到`Request`对象中。
5. 如果数据包的`event`标志位被设置，则设置`Request`对象为事件请求对象。
6. 创建反序列化的输入流，后续在解码的时候可以从反序列化的输入流中反序列化出Java对象。
7. 判断请求对象的类型是具体哪种事件请求，然后采用对应的解码方式解码请求。
8. 解码普通的调用请求，这里把对调用请求的解码过程委托给了`DecodeableRpcInvocation`的`decode()`方法进行解码处理。在委托给`DecodeableRpcInvocation`进行解码的时候，需要检查Dubbo的配置项`decode.in.io`，如果为`true`则表示在IO线程上进行解码，否则由分派策略决定在哪个线程中解码。关于IO线程和分派策略的内容，可以参考这篇文章[《Dubbo源码解析——线程模型》](/2020/02/10/Dubbo源码解析-线程模型)。`decode.in.io`的默认值为`true`，表示默认在IO线程中进行解码，这里直接调用了`DecodeableRpcInvocation`的`decode()`方法进行解码操作（关于IO线程的问题，由于编解码器和底层通信框架是高度相关的，编解码过程发生在从网络层向应用层和应用层向网络层传递数据的过程中，对于类似Netty之类的异步IO框架来说，这个过程一般都在IO线程中完成）。
9. 将`DecodeableRpcInvocation`对象设置`Request`的`data`字段中。

#### DecodeableRpcInvocation

`DecodeableRpcInvocation`对应了dubbo协议请求报文中消息体部分的数据，用于表示消息体中可变部分的数据。`DecodeableRpcInvocation`继承自`RpcInvocation`，`RpcInvocation`在Dubbo中用于表示一个远程调用的上下文信息。`DecodeableRpcInvocation`实现了`Decodeable`接口，用于提供解码请求报文中可变部分数据部分的功能。

下面，我们来看下`DecodeableRpcInvocation`中对请求消息体的解码逻辑：

{% highlight java %}
public class DecodeableRpcInvocation extends RpcInvocation implements Codec, Decodeable {
  @Override
  public void decode() throws Exception {
      if (!hasDecoded && channel != null && inputStream != null) { // 1
          try {
              decode(channel, inputStream);
          } catch (Throwable e) {
              if (log.isWarnEnabled()) {
                  log.warn("Decode rpc invocation failed: " + e.getMessage(), e);
              }
              request.setBroken(true);
              request.setData(e);
          } finally {
              hasDecoded = true;
          }
      }
  }
  
  @Override
  public Object decode(Channel channel, InputStream input) throws IOException {
      ObjectInput in = CodecSupport.getSerialization(channel.getUrl(), serializationType)
              .deserialize(channel.getUrl(), input); // 2

      String dubboVersion = in.readUTF(); // 3
      request.setVersion(dubboVersion); // 3
      setAttachment(DUBBO_VERSION_KEY, dubboVersion); // 4

      setAttachment(PATH_KEY, in.readUTF()); // 4
      setAttachment(VERSION_KEY, in.readUTF()); // 4

      setMethodName(in.readUTF()); // 4
      try {
          Object[] args;
          Class<?>[] pts;
          String desc = in.readUTF(); // 5
          if (desc.length() == 0) {
              pts = DubboCodec.EMPTY_CLASS_ARRAY; // 5
              args = DubboCodec.EMPTY_OBJECT_ARRAY; // 5
          } else {
              pts = ReflectUtils.desc2classArray(desc); // 5
              args = new Object[pts.length]; // 5
              for (int i = 0; i < args.length; i++) {
                  try {
                      args[i] = in.readObject(pts[i]); // 5
                  } catch (Exception e) {
                      if (log.isWarnEnabled()) {
                          log.warn("Decode argument failed: " + e.getMessage(), e);
                      }
                  }
              }
          }
          setParameterTypes(pts); // 5

          Map<String, String> map = (Map<String, String>) in.readObject(Map.class); // 6
          if (map != null && map.size() > 0) {
              Map<String, String> attachment = getAttachments(); // 6
              if (attachment == null) {
                  attachment = new HashMap<String, String>();
              }
              attachment.putAll(map);
              setAttachments(attachment); // 6
          }
          //decode argument ,may be callback
          for (int i = 0; i < args.length; i++) {
              args[i] = decodeInvocationArgument(channel, this, pts, i, args[i]); // 7
          }

          setArguments(args);

      } catch (ClassNotFoundException e) {
          throw new IOException(StringUtils.toString("Read invocation data failed.", e));
      } finally {
          if (in instanceof Cleanable) {
              ((Cleanable) in).cleanup();
          }
      }
      return this;
  }
}
{% endhighlight %}

1. 检查当前的`DecodeableRpcInvocation`对象是否已经被解码，如果还没有被解码，则调用`decode()`方法进行解码。`DecodeableRpcInvocation`是一个有状态的对象，前面我们提到过：由于`decode.in.io`可以控制解码过程在哪个线程中执行，所以`DecodeableRpcInvocation`维护了一个解码状态标记以防止重复解码。
2. 获取序列化类型，并对输入流进行反序列化，生成反序列化输入流。
3. 从反序列化输入流中重建出dubbo的版本号并设置到请求对象中。
4. 从反序列化输入流中重建出服务名称、服务版本好以及方法名称，并设置到请求对象中。
5. 从反序列化输入流中重建出方法参数类型列表。
6. 从反序列化输入流中重建出附件信息。
7. 从反序列化输入流中重建出参数值。

### 解码Response对象

下面我们来分析`decodeBody()`方法中解码`Response`对象的过程。代码如下：

{% highlight java %}
protected Object decodeBody(Channel channel, InputStream is, byte[] header) throws IOException {
    byte flag = header[2], proto = (byte) (flag & SERIALIZATION_MASK); // 1
    // get request id.
    long id = Bytes.bytes2long(header, 4); // 2
    if ((flag & FLAG_REQUEST) == 0) {
        // decode response.
        Response res = new Response(id); // 2
        if ((flag & FLAG_EVENT) != 0) { // 3
            res.setEvent(true);
        }
        // get status.
        byte status = header[3]; // 4
        res.setStatus(status);
        try {
            if (status == Response.OK) { // 5
                Object data;
                if (res.isHeartbeat()) {
                    ObjectInput in = CodecSupport.deserialize(channel.getUrl(), is, proto); // 5
                    data = decodeHeartbeatData(channel, in);
                } else if (res.isEvent()) {
                    ObjectInput in = CodecSupport.deserialize(channel.getUrl(), is, proto); // 5
                    data = decodeEventData(channel, in);
                } else {
                    DecodeableRpcResult result; // 6
                    if (channel.getUrl().getParameter(DECODE_IN_IO_THREAD_KEY, DEFAULT_DECODE_IN_IO_THREAD)) { // 6
                        result = new DecodeableRpcResult(channel, res, is,
                                (Invocation) getRequestData(id), proto); // 6
                        result.decode(); // 6
                    } else {
                        result = new DecodeableRpcResult(channel, res,
                                new UnsafeByteArrayInputStream(readMessageData(is)),
                                (Invocation) getRequestData(id), proto); // 6
                    }
                    data = result;
                }
                res.setResult(data);
            } else {
                ObjectInput in = CodecSupport.deserialize(channel.getUrl(), is, proto); // 7
                res.setErrorMessage(in.readUTF());
            }
        } catch (Throwable t) {
            if (log.isWarnEnabled()) {
                log.warn("Decode response failed: " + t.getMessage(), t);
            }
            res.setStatus(Response.CLIENT_ERROR);
            res.setErrorMessage(StringUtils.toString(t));
        }
        return res;
    } else {
        /* 省略 */
    }
}
{% endhighlight %}

1. 从返回的数据报文中解码出协议的`Req/Res`标记字段以及序列化方式。
2. 从报文中解码出响应对应的请求的请求ID并初始化`Response`对象。
3. 判断报文的`flag`是否被设置了`event`标记，如果是则将`Response`对象设置为事件响应对象。
4. 从报文中获取响应的状态`status`。
5. 如果响应是正常的，则对响应的结果进行反序列化。这里首先生成反序列化的输入流，然后基于响应的类型进行不同的反序列化：如果响应的是心跳事件，则调用`decodeHeartbeatData()`进行反序列化；如果是事件响应，则调用`decodeEventData()`进行反序列化；
6. 如果是普通的远程调用响应对象，则将反序列化过程委托给`DecodeableRpcResult`的`decode()`方法进行。这里和前面在请求反序列化过程中介绍的类似，响应结果的反序列化也支持IO线程反序列化或基于不同分派策略的反序列化。
7. 如果从报文中获取的响应状态是异常状态，则将异常信息反序列以后保存到`Response`对象中。

#### DecodeableRpcResult

和`DecodeableRpcInvocation`一样，`DecodeableRpcResult`对象对应了响应协议报文中的数据体。`DecodeableRpcResult`的`decode()`方法中提供了对响应报文数据体部分的解码逻辑。

{% highlight java %}
public class DecodeableRpcResult extends AppResponse implements Codec, Decodeable {
    @Override
    public void decode() throws Exception {
        if (!hasDecoded && channel != null && inputStream != null) { // 1
            try {
                decode(channel, inputStream);
            } catch (Throwable e) {
                if (log.isWarnEnabled()) {
                    log.warn("Decode rpc result failed: " + e.getMessage(), e);
                }
                response.setStatus(Response.CLIENT_ERROR);
                response.setErrorMessage(StringUtils.toString(e));
            } finally {
                hasDecoded = true;
            }
        }
    }

    @Override
    public Object decode(Channel channel, InputStream input) throws IOException {
        ObjectInput in = CodecSupport.getSerialization(channel.getUrl(), serializationType)
                .deserialize(channel.getUrl(), input); // 2

        byte flag = in.readByte(); // 3
        switch (flag) {
            case DubboCodec.RESPONSE_NULL_VALUE:
                break;
            case DubboCodec.RESPONSE_VALUE:
                handleValue(in);
                break;
            case DubboCodec.RESPONSE_WITH_EXCEPTION:
                handleException(in);
                break;
            case DubboCodec.RESPONSE_NULL_VALUE_WITH_ATTACHMENTS:
                handleAttachment(in);
                break;
            case DubboCodec.RESPONSE_VALUE_WITH_ATTACHMENTS:
                handleValue(in);
                handleAttachment(in);
                break;
            case DubboCodec.RESPONSE_WITH_EXCEPTION_WITH_ATTACHMENTS:
                handleException(in);
                handleAttachment(in);
                break;
            default:
                throw new IOException("Unknown result flag, expect '0' '1' '2' '3' '4' '5', but received: " + flag);
        }
        if (in instanceof Cleanable) {
            ((Cleanable) in).cleanup();
        }
        return this;
    }
}
{% endhighlight %}

1. 判断是否已经被解码过，和`DecodeableRpcInvocation`一样，`DecodeableRpcResult`也是一个有状态的对象。
2. 生成反序列化输入流。
3. 从数据报文中获取响应报文的类型标记，然后基于不同的类型标记执行不同的反序列化逻辑。

### DecodeHandler

前面我们提到，Dubbo在解码请求和响应报文的数据体的时候，支持在IO线程中解码还是基于分派策略在线程池中进行解码，这个解码策略由参数`decode.in.io`控制，默认是由IO线程负责解码过程，不过也支持基于分派策略的解码。

在[《Dubbo源码解析——线程模型》](/2020/02/10/Dubbo源码解析-线程模型)中我们详细介绍了关于Dubbo线程模型和分派策略。Dubbo的线程分派策略的实现是基于对`ChannelHandler`的装饰器模式实现的，所以为了让解码可以基于不同分配策略在IO线程之外的线程中执行，Dubbo提供了一个`DecodeHandler`处理器。

`DecodeHandler`是一个`ChannelHandler`的装饰器，为`ChannelHandler`提供了解码的能力。`DecodeHandler`在`HeaderExchange`创建`ExchangeClient`和`ExchangeServer`的时候对传入的`ChannelHandler`适配器进行装饰。

{% highlight java %}
public class HeaderExchanger implements Exchanger {
    public static final String NAME = "header";
    @Override
    public ExchangeClient connect(URL url, ExchangeHandler handler) throws RemotingException {
        return new HeaderExchangeClient(Transporters.connect(url, new DecodeHandler(new HeaderExchangeHandler(handler))), true);
    }

    @Override
    public ExchangeServer bind(URL url, ExchangeHandler handler) throws RemotingException {
        return new HeaderExchangeServer(Transporters.bind(url, new DecodeHandler(new HeaderExchangeHandler(handler))));
    }
}
{% endhighlight %}

那么`DecodeHandler`是如何随着分配策略在IO线程之外被分配给线程池执行的呢？这个我们需要把在Transport层中对`ChannelHandler`的装饰过程和`DecodeHandler`放到一起来看。首先，Dubbo的线程分派策略也是基于装饰器模式实现的（可以参考[《Dubbo源码解析——线程模型》](/2020/02/10/Dubbo源码解析-线程模型)），所以Dubbo将`DecodeHandler`装饰器和分派策略的装饰器`WrappedChannelHandler`放一起，通过嵌套的方式对同一个`ChannelHandler`进行装饰，这样就可以对每个装饰器提供的功能通过调用链（chain）串联起来。只要让分派策略装饰器的增强代码先于`DecodeHandler`的解码代码执行，那么就可以实现基于不同分派策略执行解码逻辑了。

## 通信层的编码和解码

前面我们介绍了Dubbo通过自定义的编解码器`Codec2`对请求和响应进行编码解码的过程。由于网络通信传递的是字节流数据，而在应用层中使用的是类型封装的数据，比如Java的对象。这个时候如果要将对象数据在网络中传输，就需要将对象编码成字节流已经将字节流数据解码成对象，所以数据的编码解码过程和网络通信是紧密相关的。

每个通信框架都有自己的编码和解码抽象和实现，比如Netty自己的`MessageToByteEncoder`和`ByteToMessageDecoder`实现，这些实现是和特定框架强相关的，所以为了让Dubbo自定义的`Codec2`编解码器和底层通信框架中的编解码器打通，我们就需要将`Codec2`适配成对应的通信框架的编解码器。在Dubbo中为`Netty`、`Mina`以及`Grizzly`这些通信框架都提供了对应的编解码适配器：`NettyCodecAdapter`、`MinaCodecAdapter`以及`GrizzlyCodecAdapter`。接下来，我们以Netty4框架的`NettyCodecAdapter`适配器为例来看下如何将`Codec2`编解码器适配到通信层的编解码器上。

### Netty的编码器和解码器

在开始介绍`Codec2`适配Netty编解码器的适配器之前，我们先来看下Netty框架提供的编解码。Netty是一个基于事件驱动的异步IO通信框架，数据的流入和流出都被作为事件进行处理，由`ChannelInboundHandler`处理输入事件，输出事件则由`ChannelOutboundHandler`负责处理。Netty通过将这两种事件处理器串联起来组成一个处理器链来处理数据流。其中编解码器就是这个事件处理器链中至关重要的一步。

![channelHandlerChain](/assets/images/rpc_5-5.png){:width="80%" hight="80%"}

Netty的解码器实际上就是输入流处理器的一种，比如实现从字节流转成对象的解码器`ByteToMessageDecoder`就是`ChannelInboundHandler`的一个子类。同样，编码器本质上也是一个输出流处理器，`MessageToByteEncoder`实现了从对象到字节流的编码过程，它是`ChannelOutboundHandler`的子类。

### 适配编码器

Dubbo提供了`NettyCodecAdapter`适配器用于适配Netty通信框架的编解码器。`NettyCodecAdapter`创建了一个`InternalEncoder`内部类用于适配Netty的编码器。`InternalEncoder`通过继承`MessageToByteEncoder`实现了一个Netty的编码器，在这个编码器内部将`encode()`委托给了`Codec2`的`encode()`，实现了对编码逻辑的适配。

{% highlight java %}
final public class NettyCodecAdapter {
    private final ChannelHandler encoder = new InternalEncoder();
    private final ChannelHandler decoder = new InternalDecoder();
    private final Codec2 codec; // 1
    private final URL url;
    private final org.apache.dubbo.remoting.ChannelHandler handler;

    public NettyCodecAdapter(Codec2 codec, URL url, org.apache.dubbo.remoting.ChannelHandler handler) {
        this.codec = codec;
        this.url = url;
        this.handler = handler;
    }

    public ChannelHandler getEncoder() {
        return encoder;
    }

    private class InternalEncoder extends MessageToByteEncoder {
        @Override
        protected void encode(ChannelHandlerContext ctx, Object msg, ByteBuf out) throws Exception {
            org.apache.dubbo.remoting.buffer.ChannelBuffer buffer = new NettyBackedChannelBuffer(out);
            Channel ch = ctx.channel();
            NettyChannel channel = NettyChannel.getOrAddChannel(ch, url, handler);
            try {
                codec.encode(channel, buffer, msg); // 2
            } finally {
                NettyChannel.removeChannelIfDisconnected(ch);
            }
        }
    }
    
    /* 省略 */
}
{% endhighlight %}

1. Dubbo自定义的`Codec2`编解码器实现。
2. 在`InternalEncoder`中将`encode()`适配给`Codec2`的`decode()`方法。

### 适配解码器

解码器适配器通过`InternalDecoder`实现了`Codec2`的`decode()`方法和Netty解码器的适配。`InternalDecoder`通过继承`ByteToMessageDecoder`实现了Netty的解码器，在解码器内部通过将`decode()`委托给`Codec2`的`decode()`方法来实现解码器的适配。

{% highlight java %}
private class InternalDecoder extends ByteToMessageDecoder {
    @Override
    protected void decode(ChannelHandlerContext ctx, ByteBuf input, List<Object> out) throws Exception {
        ChannelBuffer message = new NettyBackedChannelBuffer(input);
        NettyChannel channel = NettyChannel.getOrAddChannel(ctx.channel(), url, handler);

        try {
            // decode object.
            do {
                int saveReaderIndex = message.readerIndex();
                Object msg = codec.decode(channel, message);
                if (msg == Codec2.DecodeResult.NEED_MORE_INPUT) { // 1
                    message.readerIndex(saveReaderIndex);
                    break;
                } else {
                    //is it possible to go here ?
                    if (saveReaderIndex == message.readerIndex()) {
                        throw new IOException("Decode without read data.");
                    }
                    if (msg != null) {
                        out.add(msg);
                    }
                }
            } while (message.readable());
        } finally {
            NettyChannel.removeChannelIfDisconnected(ctx.channel());
        }
    }
}
{% endhighlight %}

1. 在`InternalDecoder`中通过`Codec2.decode()`的返回值控制解码过程，如果返回值是`NEET_MORE_INPUT`，则从`InternalDecoder`的`decode()`方法返回。Netty框架会自动驱动整个编码过程，只要`out`的列表为空解码器`InternalDecoder`将会一直被调用。

## 总结

在本文中，我们介绍了Dubbo自定义的二进制协议，分析了Dubbo对二进制数据进行编码和解码的过程。最后介绍了Dubbo如何和底层通信框架的编码器和解码器进行适配。