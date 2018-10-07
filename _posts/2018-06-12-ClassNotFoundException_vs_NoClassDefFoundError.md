---
layout: post
title:  ClassNotFoundException VS NoClassDefFoundError
date:   2018-06-10 20:35:00 +0800
categories: programing-language
tags: java
published: true
---

## 前言
在写Java程序的时候，当一个类找不到的时候，JVM有时候会抛出 **ClassNotFoundException** 异常，而有时候又会抛出 **NoClassDefFoundError**。看两个异常的字面意思，好像都是类找不到，但是JVM为什么要用两个异常去区分类找不到的情况呢？这个两个异常有什么不同的地方呢？

## ClassNotFoundException

**ClassNotFoundException** 是一个运行时异常。从类继承层次上来看，**ClassNotFoundException** 是从 **Exception** 继承的，所以 **ClassNotFoundException** 是一个检查异常。

当应用程序运行的过程中尝试使用类加载器去加载Class文件的时候，如果没有在 **classpath** 中查找到指定的类，就会抛出 **ClassNotFoundException** 。一般情况下，当我们使用`Class.forName()`或`ClassLoader.loadClass()`或`ClassLoader.findSystemClass()`在运行时加载类的时候，如果类没有被找到，那么就会导致JVM抛出 **ClassNotFoundException**。

最简单的，当我们使用JDBC去连接数据库的时候，我们一般会使用`Class.forName()`的方式去加载JDBC的驱动，如果我们没有将驱动放到应用的 **classpath** 下，那么会导致运行时找不到类，所以运行`Class.forName()`会抛出 **ClassNotFoundException**。

{% highlight java %}
public class MainClass {
    public static void main(String[] args) {
        try {
            Class.forName("oracle.jdbc.driver.OracleDriver");
        } catch (ClassNotFoundException e) {
            e.printStackTrace();
        }
    }
}
{% endhighlight %}

输出结果：

{% highlight bash %}
$ java.lang.ClassNotFoundException: oracle.jdbc.driver.OracleDriver
      at java.net.URLClassLoader.findClass(URLClassLoader.java:381)
      at java.lang.ClassLoader.loadClass(ClassLoader.java:424)
      at sun.misc.Launcher$AppClassLoader.loadClass(Launcher.java:331)
      at java.lang.ClassLoader.loadClass(ClassLoader.java:357)
      at java.lang.Class.forName0(Native Method)
      at java.lang.Class.forName(Class.java:264)
      at MainClass.main(MainClass.java:7)
{% endhighlight %}

## NoClassDefFoundError

**NoClassDefFoundError** 异常，看命名后缀是一个 **Error** 。从类继承层次上看，**NoClassDefFoundError** 是从 **Error** 继承的。和 **ClassNotFoundException** 相比，明显的一个区别是，**NoClassDefFoundError** 并不需要应用程序去关心捕获的问题。

当JVM在加载一个类的时候，如果这个类在编译时是可用的，但是在运行时找不到这个类的定义的时候，JVM就会抛出一个 **NoClassDefFoundError** 错误。比如当我们在 **new** 一个类的实例的时候，如果在运行是类找不到，则会抛出一个 **NoClassDefFoundError** 的错误。

{% highlight java %}
public class TempClass {
}

public class MainClass {
    public static void main(String[] args) {
        TempClass t = new TempClass();
    }
}
{% endhighlight %}

输出结果：

{% highlight bash %}
$ Exception in thread "main" java.lang.NoClassDefFoundError: TempClass
      at MainClass.main(MainClass.java:6)
  Caused by: java.lang.ClassNotFoundException: TempClass
      at java.net.URLClassLoader.findClass(URLClassLoader.java:381)
      at java.lang.ClassLoader.loadClass(ClassLoader.java:424)
      at sun.misc.Launcher$AppClassLoader.loadClass(Launcher.java:331)
      at java.lang.ClassLoader.loadClass(ClassLoader.java:357)
      ... 1 more
{% endhighlight %}

## 总结

|------------------------+----------------------|
| ClassNotFoundException | NoClassDefFoundError |
|:-----------------------|:---------------------|
| 从java.lang.Exception继承，是Exception类型 | 从java.lang.Error继承，是Error类型 |
| 当动态加载Class的时候找不到类会抛出ClassNotFoundException异常  | 当编译成功以后执行过程中Class找不到导致抛出NoClassDefFoundError错误  |
| 一般在执行Class.forName()、ClassLoader.loadClass()或ClassLoader.findSystemClass()的时候抛出  | 由JVM的运行时抛出  |
|------------------------+----------------------|

